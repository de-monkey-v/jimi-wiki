import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { AsyncSubmitButton } from "@/components/AsyncSubmitButton";
import { BuildStatusBadge } from "@/components/BuildStatusBadge";
import { KnowledgeBadges, type KnowledgeBadgeLabels } from "@/components/KnowledgeBadges";
import { RevisionDiff, type RevisionDiffLabels } from "@/components/RevisionDiff";
import { knowledgeBuildStage } from "@/lib/build-ui";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import type { DraftStatus } from "@/generated/prisma/client";
import { acceptDraftAction, rejectDraftAction, restoreBuildAction, retryIndexesAction } from "../actions";

export const dynamic = "force-dynamic";

function inputCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const inputs = (value as { inputs?: unknown }).inputs;
  return Array.isArray(inputs) ? inputs.length : 0;
}

type LoadedBuild = NonNullable<Awaited<ReturnType<typeof loadBuild>>>;
type DraftRow = LoadedBuild["drafts"][number];

async function loadBuild(wikiId: string, buildId: string, draftPage: number, draftPageSize: number) {
  return prisma.knowledgeBuild.findFirst({
    where: { id: buildId, wikiId },
    include: {
      drafts: {
        orderBy: [{ status: "asc" }, { slug: "asc" }],
        skip: draftPage * draftPageSize,
        take: draftPageSize,
        include: {
          sources: { select: { sourceRevisionId: true } },
          page: {
            select: {
              title: true,
              body: true,
              category: true,
              currentVersion: true,
              origin: true,
              modelAccess: true,
              archivedAt: true,
            },
          },
        },
      },
      _count: { select: { pageManifest: true, extractions: true, drafts: true } },
    },
  });
}

function DraftCard({
  draft,
  baseRevision,
  wikiSlug,
  buildId,
  canReview,
  labels,
  diffLabels,
  badgeLabels,
}: {
  draft: DraftRow;
  baseRevision?: { title: string; body: string; category: string | null };
  wikiSlug: string;
  buildId: string;
  canReview: boolean;
  labels: {
    status: Record<DraftStatus, string>;
    baseVersion: string;
    newPage: string;
    sourceCount: string;
    openPage: string;
    currentPage: string;
    proposedPage: string;
    accept: string;
    accepting: string;
    acceptConfirm: string;
    reject: string;
    rejecting: string;
    rejectConfirm: string;
    archivedDraft: string;
  };
  diffLabels: RevisionDiffLabels;
  badgeLabels: KnowledgeBadgeLabels;
}) {
  const reviewable = draft.status === "conflict" && canReview;
  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-semibold text-stone-700">
              {labels.status[draft.status]}
            </span>
            <span className="font-mono text-xs text-stone-400">
              {draft.baseVersion == null ? labels.newPage : `${labels.baseVersion} v${draft.baseVersion}`}
            </span>
          </div>
          <h3 className="mt-2 break-words text-lg font-semibold tracking-tight text-stone-900">{draft.title}</h3>
          <p className="mt-0.5 break-all font-mono text-xs text-stone-400">/{draft.slug}</p>
        </div>
        <KnowledgeBadges origin={draft.origin} modelAccess={draft.modelAccess} labels={badgeLabels} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-stone-500">
        <span className="font-mono tabular-nums">{draft.sources.length} {labels.sourceCount}</span>
        {draft.page && !draft.page.archivedAt ? (
          <Link
            href={`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(draft.slug)}`}
            className="font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {labels.openPage} →
          </Link>
        ) : null}
        {draft.archivedAt ? <span className="font-medium text-amber-800">{labels.archivedDraft}</span> : null}
      </div>

      {(baseRevision ?? draft.page) && ["conflict", "accepted", "rejected", "stale"].includes(draft.status) ? (
        <div className="mt-5">
          <RevisionDiff
            before={{
              title: (baseRevision ?? draft.page)!.title,
              body: (baseRevision ?? draft.page)!.body,
              category: (baseRevision ?? draft.page)!.category,
            }}
            after={{ title: draft.title, body: draft.body, category: draft.category }}
            labels={{ ...diffLabels, before: labels.currentPage, after: labels.proposedPage }}
          />
        </div>
      ) : null}

      {reviewable ? (
        <div className="mt-5 flex flex-col gap-2 border-t border-stone-100 pt-4 sm:flex-row">
          <form action={acceptDraftAction}>
            <input type="hidden" name="wikiSlug" value={wikiSlug} />
            <input type="hidden" name="buildId" value={buildId} />
            <input type="hidden" name="draftId" value={draft.id} />
            <AsyncSubmitButton
              idle={labels.accept}
              pending={labels.accepting}
              confirmMessage={labels.acceptConfirm}
              className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:w-auto"
            />
          </form>
          <form action={rejectDraftAction}>
            <input type="hidden" name="wikiSlug" value={wikiSlug} />
            <input type="hidden" name="buildId" value={buildId} />
            <input type="hidden" name="draftId" value={draft.id} />
            <AsyncSubmitButton
              idle={labels.reject}
              pending={labels.rejecting}
              confirmMessage={labels.rejectConfirm}
              className="w-full rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 sm:w-auto"
            />
          </form>
        </div>
      ) : null}
    </article>
  );
}

export default async function KnowledgeBuildDetail({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; buildId: string }>;
  searchParams: Promise<{ draftPage?: string }>;
}) {
  const [{ slug: rawSlug, buildId: rawBuildId }, query, t, ts, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations("KnowledgeBuilds"),
    getTranslations("KnowledgeStatus"),
    getLocale(),
  ]);
  const slug = decodeURIComponent(rawSlug);
  const buildId = decodeURIComponent(rawBuildId);
  const requestedDraftPage = Number(query.draftPage ?? "0");
  const draftPage = Number.isSafeInteger(requestedDraftPage) && requestedDraftPage >= 0 ? requestedDraftPage : 0;
  const draftPageSize = 25;
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const build = await loadBuild(wiki.id, buildId, draftPage, draftPageSize);
  if (!build) notFound();
  const draftPageCount = Math.max(1, Math.ceil(build._count.drafts / draftPageSize));
  const baseRevisionRequests = build.drafts.flatMap((draft) =>
    draft.pageId && draft.baseVersion !== null
      ? [{ pageId: draft.pageId, version: draft.baseVersion }]
      : [],
  );
  const baseRevisions = baseRevisionRequests.length
    ? await prisma.pageRevision.findMany({
        where: { OR: baseRevisionRequests },
        select: { pageId: true, version: true, title: true, body: true, category: true },
      })
    : [];
  const baseRevisionByKey = new Map(
    baseRevisions.map((revision) => [`${revision.pageId}:${revision.version}`, revision]),
  );

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
  const autoDrafts = build.drafts.filter((draft) => draft.status === "published");
  const reviewDrafts = build.drafts.filter((draft) => ["conflict", "accepted", "rejected", "stale"].includes(draft.status));
  const otherDrafts = build.drafts.filter((draft) => !autoDrafts.includes(draft) && !reviewDrafts.includes(draft));
  const canReview = wiki.role !== "viewer";
  const badgeLabels: KnowledgeBadgeLabels = {
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
  const diffLabels: RevisionDiffLabels = {
    region: t("diff.region"),
    title: t("diff.title"),
    category: t("diff.category"),
    body: t("diff.body"),
    before: t("diff.before"),
    after: t("diff.after"),
    added: t("diff.added"),
    removed: t("diff.removed"),
    unchanged: t("diff.unchanged"),
    fallbackSize: t("diff.fallbackSize"),
    fallbackComplexity: t("diff.fallbackComplexity"),
    empty: t("diff.empty"),
  };
  const draftLabels = {
    status: {
      staged: t("draftStatus.staged"),
      conflict: t("draftStatus.conflict"),
      published: t("draftStatus.published"),
      accepted: t("draftStatus.accepted"),
      rejected: t("draftStatus.rejected"),
      stale: t("draftStatus.stale"),
      suppressed: t("draftStatus.suppressed"),
    },
    baseVersion: t("baseVersion"),
    newPage: t("newPage"),
    sourceCount: t("sourceCount"),
    openPage: t("openPage"),
    currentPage: t("currentPage"),
    proposedPage: t("proposedPage"),
    accept: t("accept"),
    accepting: t("accepting"),
    acceptConfirm: t("acceptConfirm"),
    reject: t("reject"),
    rejecting: t("rejecting"),
    rejectConfirm: t("rejectConfirm"),
    archivedDraft: t("archivedDraft"),
  } satisfies Parameters<typeof DraftCard>[0]["labels"];

  const renderDraft = (draft: DraftRow) => (
    <DraftCard
      key={draft.id}
      draft={draft}
      baseRevision={
        draft.pageId && draft.baseVersion !== null
          ? baseRevisionByKey.get(`${draft.pageId}:${draft.baseVersion}`)
          : undefined
      }
      wikiSlug={slug}
      buildId={build.id}
      canReview={canReview}
      labels={draftLabels}
      diffLabels={diffLabels}
      badgeLabels={badgeLabels}
    />
  );

  const draftPagination = build._count.drafts > draftPageSize ? (
    <nav aria-label={t("draftPaginationLabel")} className="mt-5 flex items-center justify-between gap-3 text-sm">
      {draftPage > 0 ? (
        <Link
          className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          href={`/wikis/${encodeURIComponent(slug)}/builds/${encodeURIComponent(build.id)}?draftPage=${draftPage - 1}`}
        >
          ← {t("newerDrafts")}
        </Link>
      ) : <span />}
      <span className="font-mono text-xs tabular-nums text-stone-400">
        {t("draftPageLabel", { current: Math.min(draftPage + 1, draftPageCount), total: draftPageCount })}
      </span>
      {draftPage + 1 < draftPageCount ? (
        <Link
          className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          href={`/wikis/${encodeURIComponent(slug)}/builds/${encodeURIComponent(build.id)}?draftPage=${draftPage + 1}`}
        >
          {t("olderDrafts")} →
        </Link>
      ) : <span />}
    </nav>
  ) : null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/wikis/${encodeURIComponent(slug)}/builds`} className="text-sm text-stone-500 hover:text-stone-800 hover:underline">
          ← {t("backToBuilds")}
        </Link>
        <Link href={`/wikis/${encodeURIComponent(slug)}/builds/${encodeURIComponent(build.id)}`} className="text-xs font-medium text-indigo-600 hover:underline">
          {t("refresh")}
        </Link>
      </div>

      <header className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <BuildStatusBadge status={build.status} label={t(`status.${build.status}`)} />
              <span className="rounded-full border border-stone-200 px-2.5 py-1 text-xs font-semibold text-stone-600">{t(`mode.${build.mode}`)}</span>
              {build.forceExtraction ? <span className="text-xs font-semibold text-amber-700">{t("forced")}</span> : null}
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-stone-900">{t("detailTitle")}</h1>
            <p className="mt-1 break-all font-mono text-xs text-stone-400">{build.id}</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="font-mono text-xs tabular-nums text-stone-500">{date.format(build.createdAt)}</p>
            {build.model ? <p className="mt-1 font-mono text-xs text-stone-400">{build.model}</p> : null}
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-stone-100 pt-5 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <div><dt className="text-stone-400">{t("stageLabel")}</dt><dd className="mt-1 font-semibold">{t(`stage.${knowledgeBuildStage({ status: build.status, inputCount: inputCount(build.inputManifest), extractionCount: build._count.extractions, draftCount: build._count.drafts })}`)}</dd></div>
          <div><dt className="text-stone-400">{t("inputs")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{inputCount(build.inputManifest)}</dd></div>
          <div><dt className="text-stone-400">{t("extractions")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{build._count.extractions}</dd></div>
          <div><dt className="text-stone-400">{t("drafts")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{build._count.drafts}</dd></div>
          <div><dt className="text-stone-400">{t("publishedPages")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{build._count.pageManifest}</dd></div>
          <div><dt className="text-stone-400">{t("cost")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{build.costUsd == null ? "—" : money.format(build.costUsd)}</dd></div>
        </dl>
        {build.status === "publishedDegraded" ? (
          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-3 text-xs leading-5 text-orange-900 sm:flex-row sm:items-center sm:justify-between">
            <p>{t("degradedNotice")}</p>
            {wiki.role !== "viewer" ? (
              <form action={retryIndexesAction}>
                <input type="hidden" name="wikiSlug" value={slug} />
                <input type="hidden" name="buildId" value={build.id} />
                <AsyncSubmitButton
                  idle={t("retryIndexes")}
                  pending={t("retryingIndexes")}
                  className="rounded-lg border border-orange-300 bg-white px-3 py-2 text-xs font-semibold text-orange-900 hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-600 focus-visible:ring-offset-2"
                />
              </form>
            ) : null}
          </div>
        ) : null}
        {build.error ? (
          <details className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
            <summary className="cursor-pointer font-semibold">{t("errorHeading")}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{JSON.stringify(build.error, null, 2)}</pre>
          </details>
        ) : null}
      </header>

      {build.publishedAt && wiki.role === "owner" ? (
        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="font-semibold text-amber-950">{t("restoreHeading")}</h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-amber-900">{t("restoreBody")}</p>
              {!build.restorable ? <p className="mt-2 text-xs font-semibold text-rose-700">{build.unrestorableReason ?? t("unrestorable")}</p> : null}
            </div>
            <form action={restoreBuildAction}>
              <input type="hidden" name="wikiSlug" value={slug} />
              <input type="hidden" name="buildId" value={build.id} />
              <AsyncSubmitButton
                idle={t("restore")}
                pending={t("restoring")}
                confirmMessage={t("restoreConfirm")}
                disabled={!build.restorable}
                className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2"
              />
            </form>
          </div>
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="auto-results-heading">
        <h2 id="auto-results-heading" className="text-lg font-semibold tracking-tight text-stone-900">{t("autoSection")}</h2>
        <p className="mt-1 text-sm text-stone-500">{t("autoSectionBody")}</p>
        <div className="mt-3 space-y-3">
          {autoDrafts.length ? autoDrafts.map(renderDraft) : <p className="rounded-xl border border-dashed border-stone-300 bg-white px-4 py-8 text-center text-sm text-stone-500">{t("noAuto")}</p>}
        </div>
      </section>

      <section className="mt-8" aria-labelledby="review-results-heading">
        <h2 id="review-results-heading" className="text-lg font-semibold tracking-tight text-stone-900">{t("reviewSection")}</h2>
        <p className="mt-1 text-sm text-stone-500">{t("reviewSectionBody")}</p>
        <div className="mt-3 space-y-3">
          {reviewDrafts.length ? reviewDrafts.map(renderDraft) : <p className="rounded-xl border border-dashed border-stone-300 bg-white px-4 py-8 text-center text-sm text-stone-500">{t("noReview")}</p>}
        </div>
      </section>

      {otherDrafts.length ? (
        <section className="mt-8" aria-labelledby="other-results-heading">
          <h2 id="other-results-heading" className="text-lg font-semibold tracking-tight text-stone-900">{t("otherSection")}</h2>
          <div className="mt-3 space-y-3">{otherDrafts.map(renderDraft)}</div>
        </section>
      ) : null}
      {draftPagination}
    </main>
  );
}
