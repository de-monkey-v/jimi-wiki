import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPage, getBacklinks, getOutlinks, existingSlugSet, getWikiToc, getPrevNext, getPageProvenance, getPageSources } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";
import { isAiExcludedKind, type TocEntry } from "@/lib/kinds";
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
            <Link href={`${basePath}/p/${encodeURIComponent(e.slug)}`} className="ui-link rounded">
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
  const t = await getTranslations("PublicWikiView");
  const tw = await getTranslations("WikiToc"); // 사이드바 섹션 라벨 공유(WikiToc와 동일 키)
  const crumb = (
    <div className="page-breadcrumb">
      <Link href={basePath}>{title}</Link>
      <span className="ui-badge ml-2">{t("readOnly")}</span>
    </div>
  );

  if (pageSlug) {
    const page = await getPage(wikiId, pageSlug);
    if (!page) notFound();
    // 개인 노트(AI 제외)는 공개 뷰에 절대 노출하지 않는다 — 익명 독자가 slug로 직접 접근해도 숨김.
    if (isAiExcludedKind(page.kind)) notFound();
    // Source projection note는 사용자용 페이지가 아니다. 공개 공유에서는 원문 보관함도 제공하지 않는다.
    if (page.kind === "note" && page.sourceId) notFound();
    const existing = await existingSlugSet(wikiId);
    const html = await renderMarkdown(page.body, {
      hrefFor: (t) => `${basePath}/p/${encodeURIComponent(t)}`,
      exists: (t) => existing.has(t),
    });
    const [backlinks, outlinks, { prev, next }] = await Promise.all([
      getBacklinks(wikiId, page.id),
      getOutlinks(wikiId, page.id),
      getPrevNext(wikiId, pageSlug, { includePersonal: false }), // 공개 prev/next에 개인 노트 미포함
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
        emptyText={t("emptyPage")}
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

  const { sections } = await getWikiToc(wikiId, { includePersonal: false }); // 공개 사이드바에 개인 노트 미노출
  return (
    <main className="mx-auto reading-measure px-4 py-10 sm:px-6">
      {crumb}
      <header className="page-header">
        <p className="page-kicker">Shared archive</p>
        <h1 className="page-title">{title}</h1>
      </header>
      {sections.length === 0 ? (
        <div className="surface-panel p-6">
          <EmptyState
            asset="read-only-share"
            title={t("emptyTitle")}
            body={t("emptyBody")}
          />
        </div>
      ) : (
        <div className="surface-panel space-y-6 p-5 sm:p-6">
          {sections.map((s) => (
            <section key={s.key}>
              <h2 className="mb-2 text-sm font-semibold text-stone-500">{tw(`section.${s.key}`)}</h2>
              <EntryList entries={s.entries} basePath={basePath} />
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
