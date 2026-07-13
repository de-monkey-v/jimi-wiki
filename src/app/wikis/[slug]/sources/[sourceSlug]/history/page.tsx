import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { RevisionHistoryView, type HistoryRevision, type RevisionHistoryLabels } from "@/components/RevisionHistoryView";
import type { KnowledgeBadgeLabels } from "@/components/KnowledgeBadges";
import type { RevisionDiffLabels } from "@/components/RevisionDiff";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";

export const dynamic = "force-dynamic";
const HISTORY_PAGE_SIZE = 50;

export default async function SourceRevisionHistory({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; sourceSlug: string }>;
  searchParams: Promise<{ revision?: string; page?: string }>;
}) {
  const [{ slug: rawSlug, sourceSlug: rawSourceSlug }, query, t, ts, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations("KnowledgeHistory"),
    getTranslations("KnowledgeStatus"),
    getLocale(),
  ]);
  const slug = decodeURIComponent(rawSlug);
  const sourceSlug = decodeURIComponent(rawSourceSlug);
  const selectedId = query.revision;
  const pageIndex = /^\d+$/.test(query.page ?? "") ? Number(query.page) : 0;
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) notFound();
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const source = await prisma.source.findUnique({
    where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } },
    select: {
      id: true,
      title: true,
      currentVersion: true,
      _count: { select: { revisions: true } },
      revisions: {
        orderBy: { version: "desc" },
        skip: pageIndex * HISTORY_PAGE_SIZE,
        take: HISTORY_PAGE_SIZE + 1,
        select: {
          id: true,
          version: true,
          title: true,
          url: true,
          body: true,
          actor: true,
          reason: true,
          createdAt: true,
          modelAccess: true,
          archivedAt: true,
          contentHash: true,
        },
      },
    },
  });
  if (!source) notFound();
  if (pageIndex > 0 && source.revisions.length === 0) notFound();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const mapped: HistoryRevision[] = source.revisions.map((item) => ({
    id: item.id,
    version: item.version,
    title: item.title,
    body: item.body ?? "",
    category: item.url,
    categoryLabel: t("diff.url"),
    actor: item.actor,
    reason: item.reason,
    createdAtLabel: date.format(item.createdAt),
    modelAccess: item.modelAccess,
    archivedAt: item.archivedAt,
    contentHash: item.contentHash,
  }));
  const revisions = mapped.slice(0, HISTORY_PAGE_SIZE);
  const comparisonBefore = mapped[HISTORY_PAGE_SIZE];
  const pageCount = Math.max(1, Math.ceil(source._count.revisions / HISTORY_PAGE_SIZE));
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
  const labels: RevisionHistoryLabels = {
    back: t("backToSource"),
    heading: t("sourceHeading", { title: source.title }),
    subtitle: t("sourceSubtitle", { count: source._count.revisions }),
    timeline: t("timeline"),
    current: t("current"),
    selected: t("selected"),
    compareHeading: t("compareHeading"),
    initialSnapshot: t("initialSnapshot"),
    actor: {
      human: t("actor.human"),
      agent: t("actor.agent"),
      system: t("actor.system"),
      restore: t("actor.restore"),
    },
    reasonFallback: t("reasonFallback"),
    stateHeading: t("stateHeading"),
    kind: t("kind"),
    modelAccess: t("modelAccess"),
    documentState: t("documentState"),
    archived: t("archived"),
    active: t("active"),
    contentHash: t("contentHash"),
    sources: t("sources"),
    restore: t("restoreSource"),
    restoring: t("restoring"),
    restoreConfirm: t("restoreSourceConfirm"),
    restoreNotice: t("restoreNotice"),
    restoreFailed: t("restoreFailed"),
    empty: t("empty"),
    previousPage: t("previousPage"),
    nextPage: t("nextPage"),
  };
  const diffLabels: RevisionDiffLabels = {
    region: t("diff.region"),
    title: t("diff.title"),
    category: t("diff.url"),
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

  return (
    <RevisionHistoryView
      backHref={`/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}`}
      revisions={revisions}
      currentVersion={source.currentVersion}
      selectedId={selectedId}
      hrefForRevision={(id) => `/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}/history?page=${pageIndex}&revision=${encodeURIComponent(id)}`}
      labels={labels}
      diffLabels={diffLabels}
      badgeLabels={badgeLabels}
      canRestore={wiki.role !== "viewer"}
      restoreApiUrl={`/api/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}/revisions`}
      comparisonBefore={comparisonBefore}
      pagination={{
        label: t("pageLabel", { current: pageIndex + 1, total: pageCount }),
        previousHref: pageIndex > 0 ? `/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}/history?page=${pageIndex - 1}` : undefined,
        nextHref: pageIndex + 1 < pageCount ? `/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}/history?page=${pageIndex + 1}` : undefined,
      }}
    />
  );
}
