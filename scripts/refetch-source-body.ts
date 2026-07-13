import "dotenv/config";
import { prisma } from "../src/lib/db";
import { fetchAsText } from "../src/lib/ingest";
import { reindexSource } from "../src/lib/search";
import { updateSourceSnapshot } from "../src/lib/content-store";
import { queueIncrementalKnowledgeBuild } from "../src/lib/builds";

/**
 * 기존 Source의 url을 현재 본문 추출 로직(extractFromHtml)으로 다시 받아와 새 SourceRevision을 생성 + 재색인.
 * 구버전(원시 strip)으로 편입돼 nav 잡음이 섞인 레거시 원문을 깨끗하게 만든다.
 * external이면 새 revision을 입력으로 incremental build를 큐잉하고, internalOnly면 로컬 projection/FTS만 갱신한다.
 *
 * 실행(server-only import → shim 필요):
 *   pnpm tsx --require ./scripts/server-only-shim.cjs scripts/refetch-source-body.ts <sourceSlug> [<sourceSlug> ...]
 * (편의 스크립트 pnpm refetch:source 참고)
 */
async function main() {
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (slugs.length === 0) {
    console.error("사용법: refetch-source-body.ts <sourceSlug> [<sourceSlug> ...]");
    process.exit(1);
  }

  for (const slug of slugs) {
    const src = await prisma.source.findFirst({
      where: { slug, archivedAt: null },
      select: { id: true, wikiId: true, slug: true, title: true, url: true, currentVersion: true },
    });
    if (!src) {
      console.log(`✗ ${slug}: Source 없음 — 건너뜀`);
      continue;
    }
    if (!src.url) {
      console.log(`✗ ${slug}: url 없음(직접 입력 원문) — 재추출 불가, 건너뜀`);
      continue;
    }
    try {
      const { text, title } = await fetchAsText(src.url);
      if (!text.trim()) {
        console.log(`✗ ${slug}: 추출 본문이 비어 있음 — 건너뜀`);
        continue;
      }
      const newTitle = title?.trim() || src.title; // 추출 제목 있으면 hostname 제목 교정
      const saved = await updateSourceSnapshot({
        wikiId: src.wikiId,
        sourceId: src.id,
        expectedVersion: src.currentVersion,
        changes: { body: text, title: newTitle },
        context: { actor: "system", reason: "URL refetch" },
      });
      await reindexSource(src.wikiId, { id: src.id, slug: src.slug, body: text });
      let queued = "";
      if (saved.source.modelAccess === "external") {
        const { buildId } = await queueIncrementalKnowledgeBuild(
          src.wikiId,
          null,
          saved.revision.id,
        );
        queued = `, incremental build ${buildId} 큐잉`;
      }
      console.log(`✓ ${slug}: ${text.length}자 revision 생성${title ? `, 제목 → "${newTitle}"` : ""}${queued}`);
    } catch (e) {
      console.log(`✗ ${slug}: ${(e as Error).message}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
