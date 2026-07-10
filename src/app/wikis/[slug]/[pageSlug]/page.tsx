import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getPage, getBacklinks, getOutlinks, existingSlugSet, getPrevNext, getPageProvenance, getPageSources, getPageNeighborhood, isPagePinned } from "@/lib/wiki";
import { PinButton } from "./PinButton";
import { RecordVisit } from "../RecordVisit";
import { renderMarkdown } from "@/lib/markdown";
import { detectLang } from "@/lib/lang";
import { getPageTranslation } from "@/lib/translate";
import { checkDailyQuota } from "@/lib/usage";
import { isAiExcludedKind } from "@/lib/kinds";
import { isLocale } from "@/i18n/locales";
import { ReadingPane } from "@/components/ReadingPane";
import TranslateMenu from "@/components/TranslateMenu";
import { GraphMount } from "@/components/graph/GraphMount";
import { CategoryBreadcrumb } from "@/components/CategoryBreadcrumb";

export default async function PageView({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; pageSlug: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const t = await getTranslations("WikisSlugPageSlugPage");
  const { slug: rawSlug, pageSlug: rawPageSlug } = await params;
  const { lang } = await searchParams;
  const slug = decodeURIComponent(rawSlug);
  const pageSlug = decodeURIComponent(rawPageSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const page = await getPage(wiki.id, pageSlug);
  if (!page) notFound();

  // 온디맨드 기계 번역: ?lang=<locale> 이 원문 언어와 다를 때만 (캐시 우선) 번역본을 렌더.
  const pageLang = detectLang(page.body || page.title).code;
  const wantLocale = isLocale(lang) && lang !== pageLang ? lang : null;
  let viewTitle = page.title;
  let viewBody = page.body;
  let translatedTo: typeof wantLocale = null; // 실제로 번역에 성공했을 때만 set → 배지 정확성
  // 개인 노트(AI 제외)는 번역하지 않는다 — 본문이 외부 LLM(Gemini/OpenAI)으로 전송되기 때문. 원문 그대로 표시.
  if (wantLocale && page.body.trim() && !isAiExcludedKind(page.kind)) {
    // 비용 경계: 번역도 생성형 LLM 소비 → 채팅과 동일하게 일일 쿼터를 적용(초과 시 원문 표시).
    const quota = await checkDailyQuota(userId);
    if (quota.ok) {
      try {
        const tr = await getPageTranslation(
          { id: page.id, title: page.title, body: page.body },
          wantLocale,
          { wikiId: wiki.id, userId },
        );
        viewTitle = tr.title;
        viewBody = tr.body;
        translatedTo = wantLocale;
      } catch (err) {
        // LLM 미설정·안전거부·빈 번역 등 → 원문 표시(배지도 안 뜸). 로그만 남긴다.
        console.error("page translation failed", { pageId: page.id, locale: wantLocale, err });
      }
    }
  }

  const existing = await existingSlugSet(wiki.id);
  const html = await renderMarkdown(viewBody, {
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
        <h2 className="mb-2 text-sm font-semibold text-stone-500">{t("connectionGraph")}</h2>
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
        <Link href="/wikis" className="hover:underline">{t("myWikis")}</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      {!isNote && page.category && <CategoryBreadcrumb wikiSlug={slug} category={page.category} />}
    </>
  );

  const canWrite = wiki.role !== "viewer";
  const pinned = await isPagePinned(userId, page.id);

  return (
    <>
      <RecordVisit wikiSlug={slug} pageSlug={pageSlug} title={page.title} />
      <ReadingPane
        title={viewTitle}
        html={html}
        isEmpty={page.body.trim() === ""}
        translateControl={page.body.trim() ? <TranslateMenu current={translatedTo} pageLang={pageLang} /> : undefined}
        pinControl={<PinButton wikiSlug={slug} pageSlug={pageSlug} pinned={pinned} />}
        create={canWrite ? { wikiSlug: slug, category: isNote ? null : page.category } : undefined}
        emptyText={canWrite ? t("emptyEditable") : t("empty")}
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
        editHref={canWrite ? `/wikis/${slug}/${pageSlug}/edit` : undefined}
        localGraph={localGraph}
      />
    </>
  );
}
