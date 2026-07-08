import "server-only";
import { mkdir, writeFile, readFile, rename, unlink, rm, access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 원본 파일(blob) 저장소. 업로드된 파일 원본을 보관해 워커가 나중에 storageKey 로 읽어 텍스트화한다.
 * 웹(Server Action)과 별도 워커 프로세스가 같은 저장소를 공유해야 하므로, 로컬 구현은 두 프로세스가
 * 공유하는 디스크 경로를 쓴다. 훗날 S3/R2 로 갈아끼울 때는 이 인터페이스만 다시 구현하면 된다.
 */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** 로컬 절대경로(파서가 경로 입력을 요구할 때). 원격 구현은 지원하지 않을 수 있다. */
  path(key: string): string;
  delete(key: string): Promise<void>;
  /** 접두사(예: `<wikiId>/`)에 속한 모든 blob 제거. 위키 삭제 시 blob 고아 방지. */
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// env 우선 + cwd 폴백(openai-oauth/model-catalog 관례). 로컬 dev 에선 web·worker 가 같은 cwd 라 .blobs 공유.
const BLOB_DIR = process.env.BLOB_DIR || path.join(process.cwd(), ".blobs");

/** storageKey → 절대경로. BLOB_DIR 바깥으로 벗어나는 키(경로 traversal)는 거부한다. */
function resolveKey(key: string): string {
  const base = path.resolve(BLOB_DIR);
  const full = path.resolve(base, key);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("잘못된 blob 키(경로 이탈)");
  return full;
}

class LocalBlobStore implements BlobStore {
  async put(key: string, data: Buffer): Promise<void> {
    const full = resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    // 원자적 쓰기: 같은 디렉토리 tmp 에 쓰고 rename(같은 FS 보장 → rename 은 원자적)
    const tmp = `${full}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    try {
      await rename(tmp, full);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(resolveKey(key));
  }

  path(key: string): string {
    return resolveKey(key);
  }

  async delete(key: string): Promise<void> {
    await unlink(resolveKey(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }

  async deletePrefix(prefix: string): Promise<void> {
    // prefix 디렉토리 통째 제거(예: `<wikiId>/`). traversal 가드 통과 필수.
    await rm(resolveKey(prefix), { recursive: true, force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }
}

let _store: BlobStore | null = null;
export function getBlobStore(): BlobStore {
  if (!_store) _store = new LocalBlobStore();
  return _store;
}

/** 저장 키 생성: `<wikiId>/<yyyy>/<mm>/<uuid>.<ext>`. POSIX 상대키 → 훗날 S3 object key 로 그대로 재해석. */
export function makeStorageKey(wikiId: string, ext: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
  const name = safeExt ? `${randomUUID()}.${safeExt}` : randomUUID();
  return `${wikiId}/${yyyy}/${mm}/${name}`;
}
