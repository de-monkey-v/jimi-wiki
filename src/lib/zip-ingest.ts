import "server-only";
import { getBlobStore, makeStorageKey } from "@/lib/blob";
import { createIngestRun, type IngestInput, type IngestMode } from "@/lib/ingest";
import type { ModelAccessValue } from "@/lib/model-access";
import {
  classifyUpload,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_RATIO,
} from "@/lib/file-types";

export function zipChildIngestInput(input: {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  modelAccess?: ModelAccessValue;
  mode: IngestMode;
}): IngestInput {
  return {
    storageKey: input.storageKey,
    filename: input.filename,
    mimeType: input.mimeType,
    size: input.size,
    ...(input.modelAccess ? { modelAccess: input.modelAccess } : {}),
    mode: input.mode,
  };
}

/**
 * zip 을 워커에서 펼쳐(fan-out) 안의 파일들을 각각 개별 Source 로 만든다: 엔트리별로 blob 저장 후
 * child ingest run 을 큐에 등록한다(워커가 이어서 처리). zip 자신은 Source 를 만들지 않는다.
 *
 * 방어: 엔트리 수·개별/총 해제 크기·압축비 상한(zip-bomb), 심볼릭 링크/디렉토리 스킵, basename 만 사용
 * (경로 traversal 무의미화), 중첩 zip 은 펼치지 않음(깊이 1 제한), 지원하지 않는 엔트리는 건너뛴다.
 * 반환: 실제로 팬아웃한 소스 수.
 */
export async function fanOutZip(opts: {
  wikiId: string;
  buffer: Buffer;
  userId?: string | null;
  /** 부모 ingest의 정책. internalOnly ZIP의 모든 child run에 그대로 상속한다. */
  modelAccess?: ModelAccessValue;
  /** 부모 run의 preserve/curate 의미를 모든 child가 그대로 상속한다. */
  mode: IngestMode;
}): Promise<number> {
  const { wikiId, buffer, userId, modelAccess, mode } = opts;
  const store = getBlobStore();
  const yauzl = (await import("yauzl")).default;

  return new Promise<number>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("zip 열기 실패"));

      let count = 0;
      let entriesSeen = 0;
      let totalUncompressed = 0;
      let aborted = false;
      const pending: Promise<void>[] = [];

      const fail = (e: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          zipfile.close();
        } catch {
          /* noop */
        }
        reject(e);
      };

      zipfile.on("error", fail);

      zipfile.on("entry", (entry) => {
        if (aborted) return;
        const name = String(entry.fileName);
        if (name.endsWith("/")) return zipfile.readEntry(); // 디렉토리 스킵

        if (++entriesSeen > ZIP_MAX_ENTRIES) return fail(new Error(`zip 엔트리 과다(>${ZIP_MAX_ENTRIES})`));

        // 심볼릭 링크/특수 파일 스킵(유닉스 모드 상위 비트 == symlink)
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) return zipfile.readEntry();

        const declared = Number(entry.uncompressedSize) || 0;
        if (declared > ZIP_MAX_ENTRY_BYTES) return fail(new Error(`zip 엔트리가 너무 큼: ${name}`));
        if (entry.compressedSize > 0 && declared / entry.compressedSize > ZIP_MAX_RATIO)
          return fail(new Error(`의심스러운 압축비(zip-bomb 의심): ${name}`));
        totalUncompressed += declared;
        if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) return fail(new Error(`zip 해제 총량 초과(>${ZIP_MAX_TOTAL_BYTES}B)`));

        zipfile.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(e ?? new Error(`엔트리 스트림 실패: ${name}`));
          const chunks: Buffer[] = [];
          let read = 0;
          stream.on("data", (c: Buffer) => {
            read += c.length;
            // 선언 크기를 넘겨 부풀리는 경우 런타임 이중 강제
            if (read > ZIP_MAX_ENTRY_BYTES) {
              stream.destroy();
              return fail(new Error(`엔트리 실제 크기 초과: ${name}`));
            }
            chunks.push(c);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (aborted) return;
            const buf = Buffer.concat(chunks);
            const base = name.split("/").pop() || name; // basename 만 사용
            const cls = classifyUpload(buf, base);
            // 중첩 zip 은 펼치지 않고(깊이 1) 지원 안 하는 엔트리도 조용히 스킵
            if (!("rejected" in cls) && cls.kind !== "zip") {
              const key = makeStorageKey(wikiId, cls.ext);
              const childInput = zipChildIngestInput({
                storageKey: key,
                filename: base,
                mimeType: cls.mimeType,
                size: buf.length,
                modelAccess,
                mode,
              });
              pending.push(
                store
                  .put(key, buf)
                  .then(() =>
                    createIngestRun(wikiId, childInput, userId ?? undefined),
                  )
                  .then(() => {
                    count++;
                  })
                  // 엔트리 하나의 put/create 실패가 전체 팬아웃을 무너뜨리지 않게 개별 삼킴(best-effort).
                  // put 은 성공했으나 create 가 실패한 경우 남는 blob 은 참조 없는 고아 → orphan-blob GC 대상.
                  .catch((e) => {
                    console.error(`[zip-ingest] 엔트리 처리 실패(스킵): ${base}: ${(e as Error).message}`);
                    store.delete(key).catch(() => {}); // 방금 쓴 blob 은 즉시 회수 시도
                  }),
              );
            }
            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", () => {
        if (aborted) return;
        Promise.all(pending)
          .then(() => resolve(count))
          .catch(fail);
      });

      zipfile.readEntry();
    });
  });
}
