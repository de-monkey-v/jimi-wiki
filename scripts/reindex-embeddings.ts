/**
 * 임베딩 전체 재색인 CLI — `pnpm reindex [wiki-slug ...]`
 *
 * 언제 쓰나: 임베딩 프로바이더·모델을 바꿨을 때(EMBED_PROVIDER / EMBED_MODEL). 벡터 공간이 달라지므로
 * 기존 벡터와 새 질의 벡터를 섞어 쓰면 검색이 조용히 망가진다 — 바꾼 뒤에는 반드시 전체를 다시 만든다.
 *
 * 하는 일: 대상 위키의 기존 임베딩을 비우고(모델이 바뀌었으므로 재사용 불가) 청크 전체를 다시 임베딩한다.
 * personal·internalOnly 는 원래 임베딩 대상이 아니라 그대로 NULL 로 남는다(reindexEmbeddings 가 보장).
 *
 * 인자 없이 실행하면 모든 위키가 대상이다.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { reindexEmbeddings } from "../src/lib/search";
import { embeddingStatus } from "../src/lib/embedding";

const MAX_BATCHES = 10_000; // 무한 루프 방지(정상적으로는 remaining=0 에서 끝난다)

async function main() {
  const status = embeddingStatus();
  console.log(`임베딩: provider=${status.provider} model=${status.model} dim=${status.dim}`);
  if (!status.enabled) {
    console.error("임베딩이 비활성입니다 — EMBED_PROVIDER 에 맞는 키(GEMINI_API_KEY) 또는 EMBED_BASE_URL 을 확인하세요.");
    process.exit(1);
  }

  const slugs = process.argv.slice(2);
  const wikis = await prisma.wiki.findMany({
    where: slugs.length ? { slug: { in: slugs } } : undefined,
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });
  if (wikis.length === 0) {
    console.log(slugs.length ? `대상 위키를 찾지 못했습니다: ${slugs.join(", ")}` : "위키가 없습니다 — 재색인할 대상이 없습니다.");
    return;
  }

  for (const wiki of wikis) {
    // 모델이 바뀌면 기존 벡터는 다른 공간의 값이라 반드시 버린다. NULL 로 만들면
    // reindexEmbeddings 가 미색인 청크로 보고 새 모델로 다시 채운다.
    const cleared = await prisma.$executeRawUnsafe(
      `UPDATE "SearchChunk" SET embedding = NULL WHERE "wikiId" = $1 AND embedding IS NOT NULL`,
      wiki.id,
    );
    const started = Date.now();
    let embedded = 0;
    let batches = 0;
    for (; batches < MAX_BATCHES; batches++) {
      const r = await reindexEmbeddings(wiki.id);
      embedded += r.embedded;
      if (r.remaining === 0) break;
      if (r.embedded === 0) {
        console.error(`  ⚠️ ${wiki.slug}: 진행이 멈췄습니다(남은 ${r.remaining}개) — 임베딩 서버 로그를 확인하세요.`);
        break;
      }
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✔ ${wiki.slug}: ${embedded}개 청크 재색인 (이전 벡터 ${cleared}개 폐기, ${secs}s)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
