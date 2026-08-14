import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getBacklinks, getOutlinks, existingSlugSet, getPrevNext, getPageProvenance, getPageSources, getPageNeighborhood, isPagePinned } from "@/lib/wiki";
import { PinButton } from "./PinButton";
import { RecordVisit } from "../RecordVisit";
import { renderMarkdown } from "@/lib/markdown";
import { detectLang } from "@/lib/lang";
import { getPageTranslation } from "@/lib/translate";
import { checkDailyQuota } from "@/lib/usage";
import { isAiExcludedKind, isPageMoveEligible, isPageTrashEligible } from "@/lib/kinds";
import { PageKebabMenu } from "@/components/PageKebabMenu";
import { isLocale } from "@/i18n/locales";
import { ReadingPane } from "@/components/ReadingPane";
import TranslateMenu from "@/components/TranslateMenu";
import { GraphMount } from "@/components/graph/GraphMount";
import { CategoryBreadcrumb } from "@/components/CategoryBreadcrumb";
import { KnowledgeBadges, type KnowledgeBadgeLabels } from "@/components/KnowledgeBadges";
import { KnowledgeControls } from "@/components/KnowledgeControls";
import { prisma } from "@/lib/db";
import { isReservedSlug } from "@/lib/ontology";
import { isPageSourcePromotionEligible } from "@/lib/page-source-promotion";
import { ResearchArticle, type ResearchEvidence } from "@/components/research/ResearchArticle";
import { safeResearchUrl } from "@/lib/research-markdown";

export default async function PageView({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; pageSlug: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const t = await getTranslations("WikisSlugPageSlugPage");
  const ts = await getTranslations("KnowledgeStatus");
  const td = await getTranslations("DocumentTypes");
  const locale = await getLocale();
  const documentDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const { slug: rawSlug, pageSlug: rawPageSlug } = await params;
  const { lang } = await searchParams;
  const slug = decodeURIComponent(rawSlug);
  const pageSlug = decodeURIComponent(rawPageSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  // 멤버 전용 상세는 archived projection도 읽어 복원/history 진입점을 유지한다.
  // 공개·모델 loader는 계속 active-only이므로 노출/AI 경계는 넓어지지 않는다.
  const page = await prisma.page.findUnique({ where: { wikiId_slug: { wikiId: wiki.id, slug: pageSlug } } });
  if (!page) notFound();
  const isResearch = page.kind === "document" && page.documentType === "research";
  const linkedSource = page.kind === "note" && page.sourceId
    ? await getPageProvenance(wiki.id, page.sourceId)
    : null;
  if (linkedSource) {
    redirect(`/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(linkedSource.slug)}`);
  }

  // 온디맨드 기계 번역: ?lang=<locale> 이 원문 언어와 다를 때만 (캐시 우선) 번역본을 렌더.
  const pageLang = detectLang(page.body || page.title).code;
  const wantLocale = isLocale(lang) && lang !== pageLang ? lang : null;
  let viewTitle = page.title;
  let viewBody = page.body;
  let translatedTo: typeof wantLocale = null; // 실제로 번역에 성공했을 때만 set → 배지 정확성
  // 개인 노트(AI 제외)는 번역하지 않는다 — 본문이 외부 LLM(Gemini/OpenAI)으로 전송되기 때문. 원문 그대로 표시.
  if (
    wantLocale &&
    page.body.trim() &&
    !page.archivedAt &&
    page.modelAccess === "external" &&
    !isResearch &&
    !isAiExcludedKind(page.kind)
  ) {
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
  const html = isResearch
    ? ""
    : await renderMarkdown(viewBody, {
        hrefFor: (t) => `/wikis/${slug}/${t}`,
        exists: (t) => existing.has(t),
      });
  const [backlinks, outlinks, { prev, next }] = await Promise.all([
    getBacklinks(wiki.id, page.id),
    getOutlinks(wiki.id, page.id),
    getPrevNext(wiki.id, pageSlug, { userId }),
  ]);

  const isNote = page.kind === "note";
  const prov = isNote ? await getPageProvenance(wiki.id, page.sourceId) : null;
  const provenance = prov
    ? { title: prov.title, href: `/wikis/${slug}/sources/${prov.slug}`, url: prov.url }
    : null;
  // 파생 페이지: 유래한 원본(들) — 원문 뷰어로 링크
  const sources = !isNote && !isResearch ? await getPageSources(wiki.id, page.id) : undefined;
  const researchRevision = isResearch
    ? await prisma.pageRevision.findUnique({
        where: { pageId_version: { pageId: page.id, version: page.currentVersion } },
        select: {
          sources: {
            orderBy: [{ ordinal: "asc" }, { id: "asc" }],
            select: {
              sourceRevisionId: true,
              sourceVersion: true,
              sourceContentHash: true,
              sourceSlug: true,
              sourceRevision: {
                select: {
                  id: true,
                  version: true,
                  title: true,
                  url: true,
                  source: { select: { slug: true, currentVersion: true } },
                },
              },
            },
          },
        },
      })
    : null;
  const researchEvidence: ResearchEvidence[] = researchRevision?.sources.map((source, index) => {
    const live = source.sourceRevision;
    const evidenceSlug = source.sourceSlug ?? live?.source.slug ?? `deleted-source-${index + 1}`;
    const historyPage = live
      ? Math.max(0, Math.floor((live.source.currentVersion - live.version) / 50))
      : 0;
    return {
      number: index + 1,
      slug: evidenceSlug,
      title: live?.title ?? null,
      preservedHref: live
        ? `/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(live.source.slug)}/history?page=${historyPage}&revision=${encodeURIComponent(live.id)}`
        : null,
      originalUrl: live?.url ? safeResearchUrl(live.url) || null : null,
      version: source.sourceVersion,
      contentHash: source.sourceContentHash,
      deleted: source.sourceRevisionId === null || !live,
    };
  }) ?? [];

  // 로컬(이웃) 그래프: 파생 페이지에서 이웃이 있을 때만(그래프=정리된 지식. note는 focal이 숨겨져 headless가 되므로 제외)
  const neighborhood = isNote || page.archivedAt ? { nodes: [], edges: [] } : await getPageNeighborhood(wiki.id, pageSlug, 1);
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
  // 케밥(⋮) 메뉴 — 접힌 수명주기 카드에 묻힌 휴지통 액션의 발견성 담당. 삭제 후엔 홈으로.
  const pageMenu = canWrite ? (
    <PageKebabMenu
      wikiSlug={slug}
      pageSlug={pageSlug}
      currentVersion={page.currentVersion}
      currentCategory={page.category}
      canMove={!page.archivedAt && !page.trashedAt && isPageMoveEligible(page)}
      canTrash={!page.trashedAt && isPageTrashEligible(page)}
      afterTrash="goHome"
      triggerClassName="btn-secondary btn-compact text-stone-500"
    />
  ) : undefined;
  const knowledgeLabels: KnowledgeBadgeLabels = {
    group: ts("group"),
    origin: {
      human: ts("origin.human"),
      generated: ts("origin.generated"),
      mixed: ts("origin.mixed"),
      system: ts("origin.system"),
    },
    modelAccess: {
      external: ts("modelAccess.external"),
      internalOnly: ts("modelAccess.internalOnly"),
    },
  };
  const headerMeta = (
    <div className="flex flex-wrap items-center gap-2">
      {page.kind === "document" && page.documentType && page.documentAt && (
        <>
          <span className="rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
            {td(page.documentType)}
          </span>
          <time dateTime={page.documentAt.toISOString()} className="font-mono text-xs tabular-nums text-stone-500">
            {documentDate.format(page.documentAt)}
          </time>
        </>
      )}
      <KnowledgeBadges origin={page.origin} modelAccess={page.modelAccess} labels={knowledgeLabels} />
      <span className="font-mono text-xs tabular-nums text-stone-400">{ts("version", { version: page.currentVersion })}</span>
      <Link
        href={`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(pageSlug)}/history`}
        className="rounded-sm text-xs font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {ts("history")}
      </Link>
    </div>
  );
  const archivedNotice = page.archivedAt ? (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span aria-hidden="true" className="mr-1.5">◇</span>
      {ts("archivedPage")}
    </div>
  ) : undefined;
  const researchStatusNotice = isResearch && page.staleAt && !page.archivedAt ? (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {t("researchStale")}
    </div>
  ) : archivedNotice;
  const knowledgeControls = canWrite ? (
    <KnowledgeControls
      resourceType="page"
      wikiSlug={slug}
      resourceSlug={page.slug}
      currentVersion={page.currentVersion}
      modelAccess={page.modelAccess}
      archived={page.archivedAt != null}
      personal={page.kind === "personal"}
      owner={wiki.role === "owner"}
      canLifecycle={page.origin !== "system"}
      canPromote={isPageSourcePromotionEligible({
        origin: page.origin,
        kind: page.kind,
        archivedAt: page.archivedAt,
        reserved: isReservedSlug(page.slug),
      })}
    />
  ) : undefined;

  return (
    <>
      {!page.archivedAt && (page.kind === "document" || page.kind === "concept" || page.kind === "entity") ? (
        <RecordVisit wikiSlug={slug} pageSlug={pageSlug} title={page.title} kind={page.kind} />
      ) : null}
      {isResearch ? (
        <ResearchArticle
          title={page.title}
          body={page.body}
          wikiSlug={slug}
          pageSlug={pageSlug}
          category={page.category}
          existingSlugs={[...existing]}
          evidence={researchEvidence}
          canCreate={canWrite && !page.archivedAt}
          canEdit={canWrite && !page.archivedAt}
          editHref={canWrite && !page.archivedAt ? `/wikis/${slug}/${pageSlug}/edit` : undefined}
          crumb={crumb}
          headerMeta={headerMeta}
          notice={researchStatusNotice}
          controls={knowledgeControls}
          pinControl={page.archivedAt ? undefined : <PinButton wikiSlug={slug} pageSlug={pageSlug} pinned={pinned} />}
          pageMenu={pageMenu}
          backlinks={backlinks}
          outlinks={outlinks}
          prev={prev}
          next={next}
          localGraph={localGraph}
        />
      ) : (
      <ReadingPane
        title={viewTitle}
        html={html}
        isEmpty={page.body.trim() === ""}
        translateControl={page.body.trim() && !page.archivedAt && page.modelAccess === "external" ? <TranslateMenu current={translatedTo} pageLang={pageLang} /> : undefined}
        pinControl={page.archivedAt ? undefined : <PinButton wikiSlug={slug} pageSlug={pageSlug} pinned={pinned} />}
        pageMenu={pageMenu}
        create={canWrite && !page.archivedAt ? { wikiSlug: slug, category: isNote ? null : page.category } : undefined}
        selection={{ pageSlug, canWrite: canWrite && !page.archivedAt }}
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
        editHref={canWrite && !page.archivedAt ? `/wikis/${slug}/${pageSlug}/edit` : undefined}
        localGraph={localGraph}
        headerMeta={headerMeta}
        notice={archivedNotice}
        controls={knowledgeControls}
      />
      )}
    </>
  );
}
