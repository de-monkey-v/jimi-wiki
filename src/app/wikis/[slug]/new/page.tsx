import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { getOntology } from "@/lib/ontology";
import { MANUAL_KIND_OPTIONS } from "@/lib/kinds";
import { NewPageForm } from "./NewPageForm";

/** 새 페이지 수동 생성 전용 화면. 제목·종류·카테고리·본문을 한 화면에서 받아 저장하고 페이지 뷰로 이동한다. */
export default async function NewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ category?: string; kind?: string }>;
}) {
  const t = await getTranslations("WikisSlugNewPage");
  const { slug: rawSlug } = await params;
  const { category, kind } = await searchParams;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  if (wiki.role === "viewer") redirect(`/wikis/${encodeURIComponent(slug)}`); // 읽기 전용은 생성 불가

  // 전체 카테고리 목록(클라이언트에서 즉시 필터링). 방어적 상한 200.
  const onto = await getOntology(wiki.id);
  const categories = onto.categories
    .slice(0, 200)
    .map((c) => ({ slug: c.slug, label: c.label, itemCount: c.itemCount ?? 0 }));
  const presetKind = MANUAL_KIND_OPTIONS.find((option) => option.value === kind)?.value;
  const presetCategory = category?.slice(0, 200);

  return (
    <main className="mx-auto compact-measure px-6 py-10">
      <div className="mb-1 text-sm text-gray-400">
        <Link href="/wikis" className="hover:underline">
          {t("myWikis")}
        </Link>{" "}
        /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">
          {wiki.title}
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold">{t("newPage")}</h1>
      <p className="mb-6 text-sm text-gray-500">{t("description")}</p>

      <NewPageForm
        wikiSlug={slug}
        wikiKind={wiki.kind}
        categories={categories}
        presetCategory={presetCategory}
        presetKind={presetKind}
      />
    </main>
  );
}
