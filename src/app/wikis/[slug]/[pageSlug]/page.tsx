import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getPage, getBacklinks, getOutlinks, existingSlugSet, getPrevNext, getPageProvenance, getPageSources, getPageNeighborhood } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";
import { ReadingPane } from "@/components/ReadingPane";
import { GraphMount } from "@/components/graph/GraphMount";
import { CategoryBreadcrumb } from "@/components/CategoryBreadcrumb";

export default async function PageView({
  params,
}: {
  params: Promise<{ slug: string; pageSlug: string }>;
}) {
  const { slug: rawSlug, pageSlug: rawPageSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const pageSlug = decodeURIComponent(rawPageSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const page = await getPage(wiki.id, pageSlug);
  if (!page) notFound();

  const existing = await existingSlugSet(wiki.id);
  const html = await renderMarkdown(page.body, {
    hrefFor: (t) => `/wikis/${slug}/${t}`,
    exists: (t) => existing.has(t),
  });
  const [backlinks, outlinks, { prev, next }] = await Promise.all([
    getBacklinks(wiki.id, page.id),
    getOutlinks(wiki.id, page.id),
    getPrevNext(wiki.id, pageSlug),
  ]);

  const isNote = page.kind === "note";
  const prov = isNote ? await getPageProvenance(wiki.id, page.sourceId) : null;
  const provenance = prov
    ? { title: prov.title, href: `/wikis/${slug}/sources/${prov.slug}`, url: prov.url }
    : null;
  // 파생 페이지: 유래한 원본(들) — 원문 뷰어로 링크
  const sources = !isNote ? await getPageSources(wiki.id, page.id) : undefined;

  // 로컬(이웃) 그래프: 파생 페이지에서 이웃이 있을 때만(그래프=정리된 지식. note는 focal이 숨겨져 headless가 되므로 제외)
  const neighborhood = isNote ? { nodes: [], edges: [] } : await getPageNeighborhood(wiki.id, pageSlug, 1);
  const localGraph =
    neighborhood.nodes.length > 1 ? (
      <section className="mt-10">
        <h2 className="mb-2 text-sm font-semibold text-stone-500">연결 그래프</h2>
        <GraphMount
          nodes={neighborhood.nodes}
          edges={neighborhood.edges}
          slug={slug}
          currentSlug={pageSlug}
          height={300}
        />
      </section>
    ) : undefined;

  const crumb = (
    <>
      <div className="mb-1 text-sm text-stone-400">
        <Link href="/wikis" className="hover:underline">내 위키</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      {!isNote && page.category && <CategoryBreadcrumb wikiSlug={slug} category={page.category} />}
    </>
  );

  return (
    <ReadingPane
      title={page.title}
      html={html}
      isEmpty={page.body.trim() === ""}
      emptyText={wiki.role !== "viewer" ? "빈 페이지입니다. 편집을 눌러 내용을 작성하세요." : "빈 페이지입니다."}
      isNote={isNote}
      provenance={provenance}
      sources={sources}
      sourceHrefFor={(s) => `/wikis/${slug}/sources/${s}`}
      backlinks={backlinks}
      outlinks={outlinks}
      prev={prev}
      next={next}
      hrefFor={(s) => `/wikis/${slug}/${s}`}
      crumb={crumb}
      editHref={wiki.role !== "viewer" ? `/wikis/${slug}/${pageSlug}/edit` : undefined}
      localGraph={localGraph}
    />
  );
}
