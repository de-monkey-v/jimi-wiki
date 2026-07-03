import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { KIND_LABEL } from "@/lib/kinds";
import { CategoryBreadcrumb } from "@/components/CategoryBreadcrumb";

export const dynamic = "force-dynamic";

/** 카테고리(및 하위) 페이지 목록. 브레드크럼 세그먼트 클릭의 목적지. */
export default async function CategoryPage({ params }: { params: Promise<{ slug: string; path: string[] }> }) {
  const { slug: rawSlug, path } = await params;
  const slug = decodeURIComponent(rawSlug);
  const prefix = path.map((s) => decodeURIComponent(s)).join("/");
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  // 정확 일치(prefix) + 하위(prefix/*). Prisma startsWith는 LIKE 메타문자(_ %)를 이스케이프하지 않으므로 직접 이스케이프(과매칭 방지: gpt_4가 gpt-4를 매칭하는 문제).
  const likePrefix = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "/";
  const pages = await prisma.page.findMany({
    where: { wikiId: wiki.id, OR: [{ category: prefix }, { category: { startsWith: likePrefix } }] },
    orderBy: [{ category: "asc" }, { title: "asc" }],
    select: { slug: true, title: true, kind: true, category: true },
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-1 text-sm text-stone-400">
        <Link href="/wikis" className="hover:underline">내 위키</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      <CategoryBreadcrumb wikiSlug={slug} category={prefix} />
      <h1 className="mb-6 text-2xl font-bold">{segLast(prefix)}</h1>
      {pages.length === 0 ? (
        <p className="text-stone-400">이 카테고리에 페이지가 없습니다.</p>
      ) : (
        <ul className="space-y-1">
          {pages.map((p) => (
            <li key={p.slug} className="flex flex-wrap items-center gap-2">
              <Link href={`/wikis/${slug}/${encodeURIComponent(p.slug)}`} className="text-blue-600 hover:underline">
                {p.title}
              </Link>
              {p.category && p.category !== prefix && <span className="text-xs text-stone-400">{p.category}</span>}
              <span className="text-xs text-stone-300">{KIND_LABEL[p.kind]}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function segLast(path: string): string {
  const s = path.split("/").filter(Boolean);
  return s[s.length - 1] ?? path;
}
