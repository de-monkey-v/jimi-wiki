import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, isFolderPinned } from "@/lib/wiki";
import { isPageTrashEligible } from "@/lib/kinds";
import { CategoryBreadcrumb } from "@/components/CategoryBreadcrumb";
import { FolderPinButton } from "./FolderPinButton";
import { CategoryList } from "./CategoryList";

export const dynamic = "force-dynamic";

/** 카테고리(및 하위) 페이지 목록. 브레드크럼 세그먼트 클릭의 목적지. */
export default async function CategoryPage({ params }: { params: Promise<{ slug: string; path: string[] }> }) {
  const { slug: rawSlug, path } = await params;
  const slug = decodeURIComponent(rawSlug);
  const prefix = path.map((s) => decodeURIComponent(s)).join("/");
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const t = await getTranslations("WikisSlugCategoryPathPage");
  const tk = await getTranslations("Kinds");
  const folderPinned = await isFolderPinned(userId, wiki.id, prefix);

  // 정확 일치(prefix) + 하위(prefix/*). Prisma startsWith는 LIKE 메타문자(_ %)를 이스케이프하지 않으므로 직접 이스케이프(과매칭 방지: gpt_4가 gpt-4를 매칭하는 문제).
  const likePrefix = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "/";
  // TOC·홈과 동일하게 활성 페이지만 — 아카이브/휴지통 페이지가 목록에 잔존하지 않게(케밥 삭제 후 행 제거).
  const pages = await prisma.page.findMany({
    where: { wikiId: wiki.id, archivedAt: null, trashedAt: null, OR: [{ category: prefix }, { category: { startsWith: likePrefix } }] },
    orderBy: [{ category: "asc" }, { title: "asc" }],
    select: { slug: true, title: true, kind: true, category: true, currentVersion: true, origin: true, sourceId: true },
  });
  const canWrite = wiki.role !== "viewer";

  return (
    <main className="mx-auto reading-measure px-6 py-10">
      <div className="mb-1 text-sm text-stone-400">
        <Link href="/wikis" className="hover:underline">{t("myWikis")}</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      <CategoryBreadcrumb wikiSlug={slug} category={prefix} />
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{segLast(prefix)}</h1>
        <FolderPinButton wikiSlug={slug} category={prefix} pinned={folderPinned} />
      </div>
      {pages.length === 0 ? (
        <p className="text-stone-400">{t("emptyCategory")}</p>
      ) : (
        <CategoryList
          rows={pages.map((p) => ({
            wikiSlug: slug,
            pageSlug: p.slug,
            title: p.title,
            categoryLabel: p.category && p.category !== prefix ? p.category : null,
            kindLabel: tk(p.kind),
            movable: canWrite && p.kind === "personal",
            canTrash: canWrite && isPageTrashEligible(p),
            currentCategory: p.category,
            currentVersion: p.currentVersion,
          }))}
        />
      )}
    </main>
  );
}

function segLast(path: string): string {
  const s = path.split("/").filter(Boolean);
  return s[s.length - 1] ?? path;
}
