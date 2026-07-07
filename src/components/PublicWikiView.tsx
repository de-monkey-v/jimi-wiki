import Link from "next/link";
import { notFound } from "next/navigation";
import { getPage, getBacklinks, getOutlinks, existingSlugSet, getWikiToc, getPrevNext, getPageProvenance, getPageSources } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";
import type { TocEntry } from "@/lib/kinds";
import { EmptyState } from "@/components/EmptyState";
import { ReadingPane } from "@/components/ReadingPane";
import { CategoryBreadcrumb } from "@/components/CategoryBreadcrumb";

/** 탐색기 엔트리(폴더/페이지)를 중첩 목록으로(공개 인덱스 모드). */
function EntryList({ entries, basePath }: { entries: TocEntry[]; basePath: string }) {
  return (
    <ul className="space-y-1">
      {entries.map((e) =>
        e.type === "page" ? (
          <li key={`p:${e.slug}`}>
            <Link href={`${basePath}/p/${encodeURIComponent(e.slug)}`} className="text-blue-600 hover:underline">
              {e.title}
            </Link>
          </li>
        ) : (
          <li key={`f:${e.path}`}>
            <div className="text-sm font-medium text-stone-500">{e.name}</div>
            <div className="ml-3 mt-1 border-l border-stone-200 pl-3">
              <EntryList entries={e.children} basePath={basePath} />
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

/** 인증 없는 읽기 전용 위키 뷰(공유 링크용). basePath 예: /s/<token> */
export async function PublicWikiView({
  wikiId,
  title,
  basePath,
  pageSlug,
}: {
  wikiId: string;
  title: string;
  basePath: string;
  pageSlug?: string;
}) {
  const crumb = (
    <div className="mb-1 text-sm text-stone-400">
      <Link href={basePath} className="hover:underline">{title}</Link>
      <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs">읽기 전용</span>
    </div>
  );

  if (pageSlug) {
    const page = await getPage(wikiId, pageSlug);
    if (!page) notFound();
    const existing = await existingSlugSet(wikiId);
    const html = await renderMarkdown(page.body, {
      hrefFor: (t) => `${basePath}/p/${encodeURIComponent(t)}`,
      exists: (t) => existing.has(t),
    });
    const [backlinks, outlinks, { prev, next }] = await Promise.all([
      getBacklinks(wikiId, page.id),
      getOutlinks(wikiId, page.id),
      getPrevNext(wikiId, pageSlug),
    ]);
    const isNote = page.kind === "note";
    const prov = isNote ? await getPageProvenance(wikiId, page.sourceId) : null;
    // 공개 뷰는 내부 원문 라우트가 없으므로 외부 원본 URL로만 provenance 노출
    const provenance = prov ? { title: prov.title, url: prov.url } : null;
    // 파생 페이지 출처: 공개는 내부 링크 없이 외부 url만(sourceHrefFor 미전달)
    const sources = !isNote ? await getPageSources(wikiId, page.id) : undefined;
    const pageCrumb = (
      <>
        {crumb}
        {!isNote && page.category && <CategoryBreadcrumb wikiSlug="" category={page.category} linked={false} />}
      </>
    );
    return (
      <ReadingPane
        title={page.title}
        html={html}
        isEmpty={page.body.trim() === ""}
        emptyText="빈 페이지입니다."
        isNote={isNote}
        provenance={provenance}
        sources={sources}
        backlinks={backlinks}
        outlinks={outlinks}
        prev={prev}
        next={next}
        hrefFor={(s) => `${basePath}/p/${encodeURIComponent(s)}`}
        crumb={pageCrumb}
      />
    );
  }

  const { sections } = await getWikiToc(wikiId);
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      {crumb}
      <h1 className="mb-6 text-2xl font-bold">{title}</h1>
      {sections.length === 0 ? (
        <div className="rounded-lg border border-stone-200 bg-white p-6">
          <EmptyState
            asset="read-only-share"
            title="공개된 페이지가 없습니다"
            body="읽기 전용 공유 위키에 페이지가 추가되면 이곳에서 열람할 수 있습니다."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map((s) => (
            <section key={s.key}>
              <h2 className="mb-2 text-sm font-semibold text-stone-500">{s.label}</h2>
              <EntryList entries={s.entries} basePath={basePath} />
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
