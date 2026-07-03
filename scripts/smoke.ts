import "dotenv/config";
import { prisma } from "../src/lib/db";

// 기반 검증: 어댑터 연결 + 관계 + pgvector 삽입/코사인 검색이 실제로 도는지
async function main() {
  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { email: `smoke-${stamp}@test.local`, name: "Smoke" },
  });
  const wiki = await prisma.wiki.create({
    data: {
      slug: `smoke-${stamp}`,
      title: "Smoke Wiki",
      kind: "personal",
      createdById: user.id,
      memberships: { create: { userId: user.id, role: "owner" } },
    },
  });
  const page = await prisma.page.create({
    data: { wikiId: wiki.id, slug: "hello", title: "안녕", kind: "note", body: "첫 페이지" },
  });

  // pgvector: 임베딩 삽입(768차원 더미) + 코사인 거리 검색
  const dim = 768;
  const vec = `[${Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SearchChunk" (id, "wikiId", "refType", "refId", heading, text, hash, embedding)
     VALUES ($1,$2,'page',$3,'','첫 페이지','h1', $4::vector)`,
    `chunk-${stamp}`, wiki.id, page.id, vec,
  );
  const rows = await prisma.$queryRawUnsafe<{ text: string; dist: number }[]>(
    `SELECT text, embedding <=> $1::vector AS dist FROM "SearchChunk" WHERE "wikiId"=$2 ORDER BY dist LIMIT 1`,
    vec, wiki.id,
  );

  // FTS 경로도 확인
  const fts = await prisma.$queryRawUnsafe<{ text: string }[]>(
    `SELECT text FROM "SearchChunk" WHERE "wikiId"=$1 AND to_tsvector('simple', text) @@ websearch_to_tsquery('simple', $2)`,
    wiki.id, "페이지",
  );

  const backlinkCount = await prisma.membership.count({ where: { wikiId: wiki.id } });

  console.log(JSON.stringify({
    ok: true,
    user: user.email,
    wiki: wiki.slug,
    page: page.slug,
    members: backlinkCount,
    vectorSearch: rows[0],
    ftsHit: fts.length,
  }, null, 2));

  // cleanup (cascade)
  await prisma.wiki.delete({ where: { id: wiki.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("SMOKE FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
