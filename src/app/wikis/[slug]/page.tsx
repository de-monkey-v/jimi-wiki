import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, listPins, listFolderPins } from "@/lib/wiki";
import { ONTOLOGY_SLUG } from "@/lib/ontology";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { EmptyState } from "@/components/EmptyState";
import { PageKebabMenu } from "@/components/PageKebabMenu";
import { isPageMoveEligible, isPageTrashEligible } from "@/lib/kinds";
import { HomeActions } from "./HomeActions";
import { ReindexForm } from "./ReindexForm";
import { RunStatusBadge } from "./RunStatusBadge";

/** 위키 홈 = 읽기 대시보드. 읽을거리→문서→지식의 소비 화면이며,
 *  원문은 전용 보관함, 최근 기록은 사이드바 팝오버에서 제공한다. */
export default async function WikiHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const t = await getTranslations("WikisSlugPage");
  const locale = await getLocale();
  const documentDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const tk = await getTranslations("Kinds");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const { run } = await searchParams;
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const canWrite = wiki.role !== "viewer"; // editor·owner만 쓰기 UI 노출(뷰어는 읽기 전용)

  // ingest 잡 상태 배지(?run=). 테넌트 격리 확인 후 표시.
  const runRow = run ? await prisma.agentRun.findUnique({ where: { id: run } }) : null;
  const runStatus = runRow && runRow.wikiId === wiki.id ? runRow : null;

  const knowledgeWhere = {
    wikiId: wiki.id,
    kind: { in: ["concept", "entity", "meta"] },
    archivedAt: null,
    slug: { not: ONTOLOGY_SLUG },
  } satisfies Prisma.PageWhereInput;
  const readingWhere = { userId, wikiId: wiki.id, trashedAt: null, promotedAt: null };
  const documentsWhere = { wikiId: wiki.id, kind: "document" as const, archivedAt: null };

  const [logs, pins, folderPins, readingLinks, readingCount, documents, documentCount, knowledge, knowledgeCategories, readablePageCount] =
    await Promise.all([
      // "최근 활동"은 사용자가 남긴 지식 활동(편입·온톨로지·질의)을 보여준다. 매 편입/방문마다 쌓이는
      // 자동 건강검진(lint)은 노이즈라 제외 — 안 그러면 목록이 lint로만 도배돼 실제 편입이 안 보인다.
      prisma.logEntry.findMany({
        where: { wikiId: wiki.id, kind: { not: "lint" } },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      listPins(wiki.id, userId),
      listFolderPins(wiki.id, userId),
      // "미읽음"의 프록시는 미편입(promotedAt=null) — SavedLink에 별도 읽음 플래그가 없다.
      prisma.savedLink.findMany({
        where: readingWhere,
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, url: true, title: true, description: true, createdAt: true },
      }),
      prisma.savedLink.count({ where: readingWhere }),
      prisma.page.findMany({
        where: documentsWhere,
        orderBy: [{ documentAt: "desc" }, { createdAt: "desc" }],
        take: 10,
        select: { id: true, slug: true, title: true, category: true, documentType: true, documentAt: true, staleAt: true, kind: true, origin: true, sourceId: true, currentVersion: true },
      }),
      prisma.page.count({ where: documentsWhere }),
      prisma.page.findMany({
        where: knowledgeWhere,
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: { id: true, slug: true, title: true, category: true, kind: true, origin: true, sourceId: true, currentVersion: true },
      }),
      prisma.page.findMany({
        where: { ...knowledgeWhere, category: { not: null } },
        select: { category: true },
        distinct: ["category"],
      }),
      // 빈 상태 판정: 홈에 실제로 보이는 것(문서·지식)만 센다 — 자동 생성되는 ontology 시스템 페이지는 제외
      prisma.page.count({
        where: { wikiId: wiki.id, archivedAt: null, kind: { notIn: ["note", "personal"] }, slug: { not: ONTOLOGY_SLUG } },
      }),
    ]);

  const knowledgeFolders = [
    ...new Set(knowledgeCategories.map((c) => c.category?.split("/")[0]).filter((v): v is string => !!v)),
  ]
    .sort()
    .slice(0, 8);

  return (
    <main className="mx-auto reading-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <p className="page-kicker">Wiki workspace</p>
        <h1 className="page-title">{wiki.title}</h1>
      </header>

      {/* ingest 잡 상태 배지: 진행 중이면 자동 폴링, 완료 시 결과 요약 + 목록 갱신 */}
      {runStatus && (
        <RunStatusBadge
          wikiSlug={slug}
          runId={runStatus.id}
          initial={{
            status: runStatus.status,
            error: runStatus.error,
            summary:
              typeof (runStatus.output as { summary?: string } | null)?.summary === "string"
                ? ((runStatus.output as { summary?: string }).summary as string)
                : null,
            pagesTouched: Array.isArray((runStatus.output as { pagesTouched?: string[] } | null)?.pagesTouched)
              ? ((runStatus.output as { pagesTouched?: string[] }).pagesTouched as string[]).length
              : 0,
          }}
        />
      )}

      {(pins.length > 0 || folderPins.length > 0) && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold text-stone-600">{t("pinnedHeading")}</h2>
          <div className="flex flex-wrap gap-2">
            {folderPins.map((p) => (
              <Link
                key={`f:${p.category}`}
                href={`/wikis/${slug}/category/${p.category.split("/").map(encodeURIComponent).join("/")}`}
                className="rounded-full border border-stone-200 bg-white px-3 py-1 text-sm text-stone-600 hover:border-indigo-200 hover:text-indigo-700"
              >
                {p.category.split("/").pop()}/
              </Link>
            ))}
            {pins.map((p) => (
              <Link
                key={p.slug}
                href={`/wikis/${slug}/${p.slug}`}
                className="rounded-full border border-stone-200 bg-white px-3 py-1 text-sm text-stone-600 hover:border-indigo-200 hover:text-indigo-700"
              >
                {p.title}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="surface-panel mb-8 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-stone-600">
            {t("readingHeading")}
            {readingCount > 0 && (
              <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                {readingCount}
              </span>
            )}
          </h2>
          <Link
            href={`/wikis/${slug}/reading`}
            className="text-sm text-stone-500 hover:text-indigo-700 hover:underline"
          >
            {t("readingAll")}
          </Link>
        </div>
        {readingLinks.length === 0 ? (
          <p className="text-sm text-stone-400">{t("readingEmpty")}</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {readingLinks.map((l) => (
              <li key={l.id} className="flex items-baseline gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm font-medium text-stone-700 hover:text-indigo-700 hover:underline"
                  >
                    {l.title || l.url}
                  </a>
                  {l.description && <p className="truncate text-xs text-stone-400">{l.description}</p>}
                </div>
                <time className="shrink-0 font-mono text-[11px] tabular-nums text-stone-400" dateTime={l.createdAt.toISOString()}>
                  {l.createdAt.toISOString().slice(0, 10)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>

      {readablePageCount === 0 && (
        <div className="surface-panel mb-8 p-5">
          <EmptyState
            asset="empty-pages"
            title={t("emptyTitle")}
            body={canWrite ? t("emptyBodyWrite") : t("emptyBodyRead")}
          />
        </div>
      )}

      {documents.length > 0 && (
        <section className="surface-panel mb-8 p-4 sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-stone-600">{t("recentDocuments")}</h2>
            {documentCount > documents.length && (
              <span className="text-xs text-stone-400">{t("moreDocuments", { count: documentCount - documents.length })}</span>
            )}
          </div>
          <ol className="space-y-2">
            {documents.map((document) => (
              <li key={document.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <time className="font-mono text-xs tabular-nums text-stone-400" dateTime={document.documentAt?.toISOString()}>
                  {document.documentAt ? documentDate.format(document.documentAt) : ""}
                </time>
                <span className="rounded-full border border-indigo-100 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                  {document.documentType ? t(`documentType.${document.documentType}`) : ""}
                </span>
                <Link href={`/wikis/${slug}/${document.slug}`} className="min-w-0 truncate text-stone-700 hover:text-indigo-700 hover:underline">
                  {document.title}
                </Link>
                {document.staleAt && <span className="text-[11px] font-medium text-amber-700">{t("researchStale")}</span>}
                <PageKebabMenu
                  wikiSlug={slug}
                  pageSlug={document.slug}
                  currentVersion={document.currentVersion}
                  currentCategory={document.category}
                  canMove={canWrite && isPageMoveEligible(document)}
                  canTrash={canWrite && isPageTrashEligible(document)}
                  triggerClassName="-my-1 ml-auto flex h-8 w-8 shrink-0 items-center justify-center self-center rounded text-base text-stone-400"
                />
              </li>
            ))}
          </ol>
        </section>
      )}

      {knowledge.length > 0 && (
        <section className="surface-panel mb-8 p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-stone-600">{t("knowledgeHeading")}</h2>
          {knowledgeFolders.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {knowledgeFolders.map((folder) => (
                <Link
                  key={folder}
                  href={`/wikis/${slug}/category/${encodeURIComponent(folder)}`}
                  className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-500 hover:border-indigo-200 hover:text-indigo-700"
                >
                  {folder}/
                </Link>
              ))}
            </div>
          )}
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {knowledge.map((p) => (
              <li key={p.id} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 rounded bg-stone-100 px-1.5 text-[11px] text-stone-500">
                  {tk.has(p.kind) ? tk(p.kind) : p.kind}
                </span>
                <Link href={`/wikis/${slug}/${p.slug}`} className="min-w-0 truncate text-sm text-stone-700 hover:text-indigo-700 hover:underline">
                  {p.title}
                </Link>
                <PageKebabMenu
                  wikiSlug={slug}
                  pageSlug={p.slug}
                  currentVersion={p.currentVersion}
                  currentCategory={p.category}
                  canMove={canWrite && isPageMoveEligible(p)}
                  canTrash={canWrite && isPageTrashEligible(p)}
                  triggerClassName="-my-1 ml-auto flex h-8 w-8 shrink-0 items-center justify-center self-center rounded text-base text-stone-400"
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 관리 액션: 읽기 대시보드라 하단에 소형으로만 (ingest·새 페이지는 모달, 재색인은 인라인) */}
      {canWrite && (
        <section className="mt-10 border-t border-stone-200 pt-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <HomeActions slug={slug} />
            <ReindexForm wikiSlug={slug} />
          </div>
        </section>
      )}

      {logs.length > 0 && (
        <details className="surface-panel-muted group mt-8 p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-semibold text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 [&::-webkit-details-marker]:hidden">
            <span>{t("systemActivity")}</span>
            <span aria-hidden="true" className="text-stone-400 transition-transform motion-reduce:transition-none group-open:rotate-90">›</span>
          </summary>
          <ul className="mt-3 space-y-1 text-sm text-stone-500">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-2">
                <span className="ui-meta">{l.createdAt.toISOString().slice(5, 16).replace("T", " ")}</span>
                <span className="ui-badge">{l.kind}</span>
                <span className="truncate">{l.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
