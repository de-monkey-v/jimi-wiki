import "dotenv/config";
import { prisma } from "../src/lib/db";
import { ensureSourceNote } from "../src/lib/ingest";

/**
 * 고아 Source 정리 도구(로컬 인스턴스용, 공개 배포 무관).
 *
 * "원문/소스" 사이드바(getWikiToc)는 kind=note 페이지 기반이라, note가 연결되지 않은 Source는
 * 목록에서 사라진다. 이 스크립트는:
 *   - 기본(리포트): note 없는 Source + sourceId 없는 note를 출력만 한다(변경 없음).
 *   - --apply: note 없는 각 Source에 스텁 note를 만들어(멱등) 목록에 노출시킨다. 삭제는 절대 하지 않는다.
 *
 * 실행(server-only 모듈을 import하므로 shim 필요):
 *   pnpm backfill:sources            # 리포트
 *   pnpm backfill:sources -- --apply # 스텁 note 생성
 */
async function main() {
  const apply = process.argv.includes("--apply");

  // note(kind=note, Page.sourceId=Source.id)가 하나도 없는 Source
  const orphanSources = await prisma.source.findMany({
    where: { pages: { none: { kind: "note" } } },
    select: { id: true, wikiId: true, slug: true, title: true, url: true, body: true, ingestedAt: true },
    orderBy: { ingestedAt: "desc" },
  });

  // 원문(Source)에 연결되지 않은 note 페이지(원문 아닌데 "원문/소스" 목록에 뜨는 것)
  const orphanNotes = await prisma.page.findMany({
    where: { kind: "note", sourceId: null },
    select: { wikiId: true, slug: true, title: true },
    orderBy: { createdAt: "desc" },
  });

  console.log(`\n=== note 없는 Source (원문/소스 목록에서 안 보이는 원문): ${orphanSources.length}개 ===`);
  for (const s of orphanSources) {
    console.log(`  [${s.wikiId}] ${s.slug}  ·  "${s.title}"${s.url ? `  <${s.url}>` : ""}`);
  }

  console.log(`\n=== sourceId 없는 note (원문 아닌데 목록에 뜨는 것): ${orphanNotes.length}개 ===`);
  for (const p of orphanNotes) {
    console.log(`  [${p.wikiId}] ${p.slug}  ·  "${p.title}"`);
  }
  if (orphanNotes.length > 0) {
    console.log(
      "\n  ↑ 이들은 수동 작성/레거시 테스트 note다. 원하면 UI 또는 DB에서 직접 삭제하라." +
        "\n    (이 스크립트는 어떤 페이지도 삭제하지 않는다.)",
    );
  }

  if (!apply) {
    console.log(`\n리포트만 수행했다. 스텁 note를 실제로 만들려면 --apply 를 붙여라.\n`);
    return;
  }

  console.log(`\n--apply: note 없는 Source ${orphanSources.length}개에 스텁 note 생성...`);
  let created = 0;
  for (const s of orphanSources) {
    // ensureSourceNote는 멱등: 이미 note가 있으면 no-op. content가 비어도 헤더 스텁은 생성된다.
    await ensureSourceNote(s.wikiId, s.id, s.slug, s.url ?? undefined, s.title, s.body ?? "");
    created++;
    console.log(`  ✓ ${s.slug}`);
  }
  console.log(`\n완료: 스텁 note ${created}개 생성. "원문/소스" 목록에 이제 노출된다.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
