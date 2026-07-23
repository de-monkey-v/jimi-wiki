import "server-only";
import {
  ContentNotFoundError,
  ContentPolicyRelaxationError,
  archiveSourceSnapshotTx,
  restoreSourceRevisionTx,
  setSourceTrashStateTx,
  updatePageSnapshotTx,
  updateSourceSnapshotTx,
  type ContentTransaction,
} from "@/lib/content-store";
import { modelAccessForKind } from "@/lib/content-policy";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import { refreshPageDerivedState, refreshSourceDerivedState } from "@/lib/page-projections";
import { reindexEmbeddings } from "@/lib/search";
import { queueIncrementalKnowledgeBuild } from "@/lib/builds";
import type {
  DocumentType,
  ModelAccess,
  PageKind,
  PageOrigin,
  PageRevision,
  SourceRevision,
} from "@/generated/prisma/client";

export interface ModelAccessTransitionPlan {
  current: ModelAccess;
  requested: ModelAccess;
  effective: ModelAccess;
  changed: boolean;
  isRelaxation: boolean;
  confirmationRequired: boolean;
}

export function planPageModelAccessTransition(input: {
  kind: PageKind;
  current: ModelAccess;
  requested: ModelAccess;
}): ModelAccessTransitionPlan {
  const effective = modelAccessForKind(input.kind, input.requested);
  const isRelaxation = input.current === "internalOnly" && effective === "external";
  return {
    current: input.current,
    requested: input.requested,
    effective,
    changed: effective !== input.current,
    isRelaxation,
    confirmationRequired: isRelaxation,
  };
}

export function planSourceModelAccessTransition(input: {
  current: ModelAccess;
  requested: ModelAccess;
}): ModelAccessTransitionPlan {
  const isRelaxation = input.current === "internalOnly" && input.requested === "external";
  return {
    current: input.current,
    requested: input.requested,
    effective: input.requested,
    changed: input.requested !== input.current,
    isRelaxation,
    confirmationRequired: isRelaxation,
  };
}

export type SourceDependentPageRole = "note" | "contribution";
export type SourcePagePropagationMode = "downgrade" | "archive";

export interface SourceDependentPageEffect {
  archive: boolean;
  markStale: boolean;
  modelAccess: ModelAccess;
}

/** Source 정책/lifecycle 변경이 현재 게시 Page에 미치는 효과를 DB와 무관하게 계산한다. */
export function planSourceDependentPageEffect(input: {
  mode: SourcePagePropagationMode;
  role: SourceDependentPageRole;
  origin: PageOrigin;
  currentModelAccess: ModelAccess;
  sourceModelAccess: ModelAccess;
}): SourceDependentPageEffect | null {
  if (input.mode === "downgrade") {
    return { archive: false, markStale: true, modelAccess: "internalOnly" };
  }
  if (input.role === "note") {
    return {
      archive: true,
      markStale: true,
      modelAccess: input.sourceModelAccess === "internalOnly" ? "internalOnly" : input.currentModelAccess,
    };
  }
  if (input.origin !== "generated") return null;
  return {
    archive: false,
    markStale: true,
    modelAccess: input.sourceModelAccess === "internalOnly" ? "internalOnly" : input.currentModelAccess,
  };
}

export interface PolicyQueueSignals {
  queueIncrementalBuild: boolean;
  queueEmbeddingReindex: boolean;
  reindexPageIds: string[];
  reindexSourceIds: string[];
  cancelledBuilds: number;
  cancelledRuns: number;
  projectionRefreshPending: boolean;
  queuedRunId?: string;
  queuedBuildId?: string;
}

interface PolicyActorInput {
  userId?: string | null;
  reason?: string | null;
}

interface AffectedPage {
  id: string;
  sourceId: string | null;
  currentVersion: number;
  origin: PageOrigin;
  modelAccess: ModelAccess;
  category: string | null;
  documentType: DocumentType | null;
  contributions: { id: string }[];
}

interface PageRevisionProvenance {
  pageId: string;
  version: number;
  sources: {
    sourceRevisionId: string | null;
    sourceRevision: { sourceId: string } | null;
  }[];
}

const POLICY_REASON = "model access policy changed";
const SOURCE_DOWNGRADE_REASON = "source model access downgraded to internalOnly";
const SOURCE_ARCHIVE_REASON = "source archived";

function assertRelaxationConfirmed(plan: ModelAccessTransitionPlan, confirmed: boolean | undefined): void {
  if (plan.confirmationRequired && confirmed !== true) throw new ContentPolicyRelaxationError();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function categoryPrefixes(category: string | null): string[] {
  const parts = category?.split("/").filter(Boolean) ?? [];
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

async function loadAffectedPages(
  tx: ContentTransaction,
  wikiId: string,
  sourceId: string,
  includeArchived: boolean,
): Promise<AffectedPage[]> {
  // PageContribution은 게시 projection이므로, projection 지연/과거 데이터가 있더라도 현재
  // PageRevision provenance에 이 Source가 있으면 놓치지 않는다.
  const revisionLinks = await tx.$queryRawUnsafe<{ pageId: string }[]>(
    `SELECT DISTINCT p.id AS "pageId"
       FROM "Page" p
       JOIN "PageRevision" pr
         ON pr."pageId" = p.id AND pr.version = p."currentVersion"
       JOIN "PageRevisionSource" prs ON prs."pageRevisionId" = pr.id
       JOIN "SourceRevision" sr ON sr.id = prs."sourceRevisionId"
      WHERE p."wikiId" = $1
        ${includeArchived ? "" : 'AND p."archivedAt" IS NULL'}
        AND sr."sourceId" = $2`,
    wikiId,
    sourceId,
  );
  const currentRevisionPageIds = unique(revisionLinks.map((link) => link.pageId));
  return tx.page.findMany({
    where: {
      wikiId,
      ...(includeArchived ? {} : { archivedAt: null }),
      OR: [
        { sourceId },
        { contributions: { some: { sourceId } } },
        ...(currentRevisionPageIds.length ? [{ id: { in: currentRevisionPageIds } }] : []),
      ],
    },
    select: {
      id: true,
      sourceId: true,
      currentVersion: true,
      origin: true,
      modelAccess: true,
      category: true,
      documentType: true,
      contributions: { where: { sourceId }, select: { id: true }, take: 1 },
    },
  });
}

async function loadCurrentPageProvenance(
  tx: ContentTransaction,
  pages: AffectedPage[],
): Promise<Map<string, PageRevisionProvenance>> {
  const byPage = new Map<string, PageRevisionProvenance>();
  for (let offset = 0; offset < pages.length; offset += 200) {
    const batch = pages.slice(offset, offset + 200);
    const revisions = await tx.pageRevision.findMany({
      where: {
        OR: batch.map((page) => ({ pageId: page.id, version: page.currentVersion })),
      },
      select: {
        pageId: true,
        version: true,
        sources: {
          select: {
            sourceRevisionId: true,
            sourceRevision: { select: { sourceId: true } },
          },
        },
      },
    });
    for (const revision of revisions) byPage.set(revision.pageId, revision);
  }
  return byPage;
}

function replaceSourceRevision(
  provenance: PageRevisionProvenance | undefined,
  sourceId: string,
  sourceRevisionId: string,
): string[] {
  const inherited = provenance?.sources ?? [];
  const next = inherited
    .filter((entry) => entry.sourceRevision?.sourceId !== sourceId)
    .flatMap((entry) => entry.sourceRevisionId ? [entry.sourceRevisionId] : []);
  next.push(sourceRevisionId);
  return unique(next);
}

async function syncSearchChunkPolicy(
  tx: ContentTransaction,
  wikiId: string,
  refs: { refType: "page" | "source"; refId: string; modelAccess: ModelAccess; archived: boolean }[],
): Promise<void> {
  const archivedPageIds = refs
    .filter((ref) => ref.refType === "page" && ref.archived)
    .map((ref) => ref.refId);
  const archivedSourceIds = refs
    .filter((ref) => ref.refType === "source" && ref.archived)
    .map((ref) => ref.refId);
  if (archivedPageIds.length) {
    await tx.searchChunk.deleteMany({
      where: { wikiId, refType: "page", refId: { in: archivedPageIds } },
    });
  }
  if (archivedSourceIds.length) {
    await tx.searchChunk.deleteMany({
      where: { wikiId, refType: "source", refId: { in: archivedSourceIds } },
    });
  }

  for (const modelAccess of ["external", "internalOnly"] as const) {
    const pageIds = refs
      .filter(
        (ref) =>
          ref.refType === "page" && !ref.archived && ref.modelAccess === modelAccess,
      )
      .map((ref) => ref.refId);
    const sourceIds = refs
      .filter(
        (ref) =>
          ref.refType === "source" && !ref.archived && ref.modelAccess === modelAccess,
      )
      .map((ref) => ref.refId);
    if (pageIds.length) {
      if (modelAccess === "internalOnly") {
        // DB CHECK가 internalOnly + non-NULL vector를 금지하므로 정책 projection보다 먼저
        // 같은 transaction 안에서 vector를 비운다.
        await tx.$executeRawUnsafe(
          `UPDATE "SearchChunk" SET "embedding" = NULL WHERE "wikiId" = $1 AND "refType" = 'page' AND "refId" = ANY($2::text[])`,
          wikiId,
          pageIds,
        );
      }
      await tx.searchChunk.updateMany({
        where: { wikiId, refType: "page", refId: { in: pageIds } },
        data: { modelAccess },
      });
    }
    if (sourceIds.length) {
      if (modelAccess === "internalOnly") {
        await tx.$executeRawUnsafe(
          `UPDATE "SearchChunk" SET "embedding" = NULL WHERE "wikiId" = $1 AND "refType" = 'source' AND "refId" = ANY($2::text[])`,
          wikiId,
          sourceIds,
        );
      }
      await tx.searchChunk.updateMany({
        where: { wikiId, refType: "source", refId: { in: sourceIds } },
        data: { modelAccess },
      });
    }
  }

}

async function removeUnbackedCategoryChunks(
  tx: ContentTransaction,
  wikiId: string,
  categories: string[],
): Promise<void> {
  for (const category of unique(categories)) {
    const externalUses = await tx.page.count({
      where: {
        wikiId,
        archivedAt: null,
        modelAccess: "external",
        kind: { not: "personal" },
        OR: [{ category }, { category: { startsWith: `${category}/` } }],
      },
    });
    if (externalUses === 0) {
      await tx.searchChunk.deleteMany({
        where: { wikiId, refType: "category", refId: `category:${category}` },
      });
    }
  }
}

async function cancelPendingModelWork(
  tx: ContentTransaction,
  wikiId: string,
  reason: string,
  now: Date,
): Promise<{ cancelledBuilds: number; cancelledRuns: number }> {
  const pending = await tx.knowledgeBuild.findMany({
    where: { wikiId, status: { in: ["pending", "review"] } },
    select: { agentRunId: true },
  });
  const runIds = unique(pending.flatMap((build) => build.agentRunId ? [build.agentRunId] : []));
  const builds = await tx.knowledgeBuild.updateMany({
    where: { wikiId, status: { in: ["pending", "review"] } },
    data: {
      status: "cancelled",
      finishedAt: now,
      error: { code: "MODEL_POLICY_CHANGED", message: reason },
    },
  });
  // AgentStatus에는 cancelled가 없으므로 pending run은 terminal error로 전이한다. running run은
  // 그대로 두고 게시 직전 policyVersion/input manifest 검증이 거부하게 한다.
  const runs = runIds.length
    ? await tx.agentRun.updateMany({
        where: { wikiId, id: { in: runIds }, status: "pending" },
        data: {
          status: "error",
          stage: null,
          error: reason,
          finishedAt: now,
        },
      })
    : { count: 0 };
  return { cancelledBuilds: builds.count, cancelledRuns: runs.count };
}

async function refreshDerivedState(input: {
  wikiId: string;
  pageIds: string[];
  sourceIds: string[];
}): Promise<boolean> {
  const tasks = [
    ...unique(input.pageIds).map(
      (pageId) => () => refreshPageDerivedState(input.wikiId, pageId),
    ),
    ...unique(input.sourceIds).map(
      (sourceId) => () => refreshSourceDerivedState(input.wikiId, sourceId),
    ),
  ];
  let pending = false;
  for (let offset = 0; offset < tasks.length; offset += 20) {
    const results = await Promise.allSettled(
      tasks.slice(offset, offset + 20).map((task) => task()),
    );
    pending ||= results.some((result) => result.status === "rejected");
  }
  return pending;
}

export interface ChangePageModelAccessInput extends PolicyActorInput {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  modelAccess: ModelAccess;
  confirmExternalAccess?: boolean;
}

export async function changePageModelAccess(input: ChangePageModelAccessInput): Promise<{
  page: Awaited<ReturnType<typeof updatePageSnapshotTx>>["projection"];
  revision: PageRevision;
  plan: ModelAccessTransitionPlan;
  signals: PolicyQueueSignals;
}> {
  const result = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const current = await tx.page.findFirst({
      where: { id: input.pageId, wikiId: input.wikiId },
      select: {
        id: true,
        kind: true,
        modelAccess: true,
        archivedAt: true,
      },
    });
    if (!current) throw new ContentNotFoundError("page");
    const plan = planPageModelAccessTransition({
      kind: current.kind,
      current: current.modelAccess,
      requested: input.modelAccess,
    });
    assertRelaxationConfirmed(plan, input.confirmExternalAccess);
    const saved = await updatePageSnapshotTx(tx, {
      wikiId: input.wikiId,
      pageId: current.id,
      expectedVersion: input.expectedVersion,
      changes: { modelAccess: plan.effective },
      preserveOriginOnRestore: true,
      allowPolicyRelaxation: input.confirmExternalAccess === true,
      context: {
        actor: "human",
        userId: input.userId ?? null,
        reason: input.reason ?? POLICY_REASON,
      },
    });
    await syncSearchChunkPolicy(tx, input.wikiId, [
      {
        refType: "page",
        refId: saved.projection.id,
        modelAccess: saved.projection.modelAccess,
        archived: saved.projection.archivedAt != null,
      },
    ]);
    return { saved, plan };
  });

  let projectionRefreshPending = await refreshDerivedState({
    wikiId: input.wikiId,
    pageIds: [result.saved.projection.id],
    sourceIds: [],
  });
  if (result.plan.isRelaxation && result.saved.projection.modelAccess === "external") {
    const embedding = await reindexEmbeddings(input.wikiId).catch(() => null);
    projectionRefreshPending ||= embedding === null;
  }
  return {
    page: result.saved.projection,
    revision: result.saved.revision,
    plan: result.plan,
    signals: {
      queueIncrementalBuild: false,
      queueEmbeddingReindex:
        result.plan.isRelaxation && result.saved.projection.modelAccess === "external",
      reindexPageIds: [result.saved.projection.id],
      reindexSourceIds: [],
      cancelledBuilds: 0,
      cancelledRuns: 0,
      projectionRefreshPending,
    },
  };
}

interface PropagateSourcePagesInput {
  tx: ContentTransaction;
  wikiId: string;
  sourceId: string;
  sourceRevision: SourceRevision;
  sourceModelAccess: ModelAccess;
  mode: SourcePagePropagationMode;
  now: Date;
  userId?: string | null;
  reason: string;
  /** 과거 Source content 복원은 dependent Page body를 재생성하지 않으므로 기존 content provenance를 유지한다. */
  preserveExistingProvenance?: boolean;
}

async function propagateSourcePages(input: PropagateSourcePagesInput): Promise<{
  pages: Awaited<ReturnType<typeof updatePageSnapshotTx>>["projection"][];
  revisions: PageRevision[];
  categories: string[];
}> {
  // downgrade는 archive/suppression 상태의 Page에도 더 엄격한 정책을 기록해 향후 restore가
  // external로 되살아나지 않게 한다. Source archive lifecycle 전파는 active Page만 대상으로 한다.
  const candidates = await loadAffectedPages(
    input.tx,
    input.wikiId,
    input.sourceId,
    input.mode === "downgrade",
  );
  const planned = candidates.flatMap((page) => {
    const role: SourceDependentPageRole =
      page.sourceId === input.sourceId ? "note" : "contribution";
    if (page.documentType === "research") {
      return [{
        page,
        effect: {
          archive: false,
          markStale: true,
          modelAccess: input.mode === "downgrade" ? "internalOnly" as const : page.modelAccess,
        },
      }];
    }
    const effect = planSourceDependentPageEffect({
      mode: input.mode,
      role,
      origin: page.origin,
      currentModelAccess: page.modelAccess,
      sourceModelAccess: input.sourceModelAccess,
    });
    return effect ? [{ page, effect }] : [];
  });
  const provenance = await loadCurrentPageProvenance(
    input.tx,
    planned.map(({ page }) => page),
  );
  const pages: Awaited<ReturnType<typeof updatePageSnapshotTx>>["projection"][] = [];
  const revisions: PageRevision[] = [];
  const categories: string[] = [];

  for (const { page, effect } of planned) {
    const saved = await updatePageSnapshotTx(input.tx, {
      wikiId: input.wikiId,
      pageId: page.id,
      expectedVersion: page.currentVersion,
      changes: {
        modelAccess: effect.modelAccess,
        ...(effect.markStale ? { staleAt: input.now } : {}),
        ...(effect.archive ? { archivedAt: input.now, suppressedAt: null } : {}),
      },
      preserveOriginOnRestore: true,
      sourceRevisionIds: input.preserveExistingProvenance || page.documentType === "research"
        ? undefined
        : replaceSourceRevision(
            provenance.get(page.id),
            input.sourceId,
            input.sourceRevision.id,
          ),
      context: {
        actor: "system",
        userId: input.userId ?? null,
        reason: input.reason,
      },
    });
    pages.push(saved.projection);
    revisions.push(saved.revision);
    categories.push(...categoryPrefixes(page.category));
  }
  return { pages, revisions, categories };
}

export interface ChangeSourceModelAccessInput extends PolicyActorInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  modelAccess: ModelAccess;
  confirmExternalAccess?: boolean;
}

export async function changeSourceModelAccess(input: ChangeSourceModelAccessInput): Promise<{
  source: Awaited<ReturnType<typeof updateSourceSnapshotTx>>["projection"];
  revision: SourceRevision;
  pageRevisions: PageRevision[];
  plan: ModelAccessTransitionPlan;
  signals: PolicyQueueSignals;
}> {
  const now = new Date();
  const result = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const current = await tx.source.findFirst({
      where: { id: input.sourceId, wikiId: input.wikiId },
      select: {
        id: true,
        modelAccess: true,
        archivedAt: true,
        curationState: true,
      },
    });
    if (!current) throw new ContentNotFoundError("source");
    const plan = planSourceModelAccessTransition({
      current: current.modelAccess,
      requested: input.modelAccess,
    });
    assertRelaxationConfirmed(plan, input.confirmExternalAccess);
    const saved = await updateSourceSnapshotTx(tx, {
      wikiId: input.wikiId,
      sourceId: current.id,
      expectedVersion: input.expectedVersion,
      changes: { modelAccess: plan.effective },
      allowPolicyRelaxation: input.confirmExternalAccess === true,
      context: {
        actor: "human",
        userId: input.userId ?? null,
        reason: input.reason ?? POLICY_REASON,
      },
    });

    const propagated =
      plan.effective === "internalOnly"
        ? await propagateSourcePages({
            tx,
            wikiId: input.wikiId,
            sourceId: current.id,
            sourceRevision: saved.revision,
            sourceModelAccess: saved.projection.modelAccess,
            mode: "downgrade",
            now,
            userId: input.userId,
            reason: SOURCE_DOWNGRADE_REASON,
          })
        : { pages: [], revisions: [], categories: [] };
    const cancelled =
      plan.effective === "internalOnly" && current.curationState === "curated"
        ? await cancelPendingModelWork(tx, input.wikiId, SOURCE_DOWNGRADE_REASON, now)
        : { cancelledBuilds: 0, cancelledRuns: 0 };

    await syncSearchChunkPolicy(tx, input.wikiId, [
      {
        refType: "source",
        refId: saved.projection.id,
        modelAccess: saved.projection.modelAccess,
        archived: saved.projection.archivedAt != null,
      },
      ...propagated.pages.map((page) => ({
        refType: "page" as const,
        refId: page.id,
        modelAccess: page.modelAccess,
        archived: page.archivedAt != null,
      })),
    ]);
    await removeUnbackedCategoryChunks(tx, input.wikiId, propagated.categories);
    return { saved, propagated, cancelled, plan };
  });

  const shouldQueueExternalWork =
    result.plan.isRelaxation &&
    result.saved.projection.archivedAt == null &&
    result.saved.projection.modelAccess === "external" &&
    result.saved.projection.curationState === "curated";
  const pageIds = result.propagated.pages.map((page) => page.id);
  let projectionRefreshPending = await refreshDerivedState({
    wikiId: input.wikiId,
    pageIds,
    sourceIds: [result.saved.projection.id],
  });
  const queued = shouldQueueExternalWork
    ? await queueIncrementalKnowledgeBuild(
        input.wikiId,
        input.userId ?? null,
        result.saved.revision.id,
      ).catch(() => null)
    : null;
  if (shouldQueueExternalWork && !queued) projectionRefreshPending = true;
  return {
    source: result.saved.projection,
    revision: result.saved.revision,
    pageRevisions: result.propagated.revisions,
    plan: result.plan,
    signals: {
      queueIncrementalBuild: shouldQueueExternalWork,
      queueEmbeddingReindex: shouldQueueExternalWork,
      reindexPageIds: pageIds,
      reindexSourceIds: [result.saved.projection.id],
      cancelledBuilds: result.cancelled.cancelledBuilds,
      cancelledRuns: result.cancelled.cancelledRuns,
      projectionRefreshPending,
      ...(queued ? { queuedRunId: queued.runId, queuedBuildId: queued.buildId } : {}),
    },
  };
}

export interface ArchiveSourceWithPropagationInput extends PolicyActorInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  trash?: {
    trashedAt: Date;
    purgeAt: Date;
    archivedBeforeTrash: boolean;
  };
}

export async function archiveSourceWithPropagation(input: ArchiveSourceWithPropagationInput): Promise<{
  source: Awaited<ReturnType<typeof archiveSourceSnapshotTx>>["projection"];
  revision: SourceRevision;
  pageRevisions: PageRevision[];
  signals: PolicyQueueSignals;
}> {
  const now = new Date();
  const result = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const current = await tx.source.findFirst({
      where: { id: input.sourceId, wikiId: input.wikiId },
      select: { id: true, curationState: true },
    });
    if (!current) throw new ContentNotFoundError("source");
    let saved = await archiveSourceSnapshotTx(tx, {
      wikiId: input.wikiId,
      sourceId: current.id,
      expectedVersion: input.expectedVersion,
      archivedAt: now,
      context: {
        actor: "human",
        userId: input.userId ?? null,
        reason: input.reason ?? SOURCE_ARCHIVE_REASON,
      },
    });
    if (input.trash) {
      const projection = await setSourceTrashStateTx(tx, {
        wikiId: input.wikiId,
        sourceId: saved.projection.id,
        ...input.trash,
      });
      saved = { ...saved, projection };
    }
    const propagated = await propagateSourcePages({
      tx,
      wikiId: input.wikiId,
      sourceId: current.id,
      sourceRevision: saved.revision,
      sourceModelAccess: saved.projection.modelAccess,
      mode: "archive",
      now,
      userId: input.userId,
      reason: SOURCE_ARCHIVE_REASON,
    });
    const cancelled = current.curationState === "curated"
      ? await cancelPendingModelWork(tx, input.wikiId, SOURCE_ARCHIVE_REASON, now)
      : { cancelledBuilds: 0, cancelledRuns: 0 };
    await syncSearchChunkPolicy(tx, input.wikiId, [
      {
        refType: "source",
        refId: saved.projection.id,
        modelAccess: saved.projection.modelAccess,
        archived: true,
      },
      ...propagated.pages.map((page) => ({
        refType: "page" as const,
        refId: page.id,
        modelAccess: page.modelAccess,
        archived: page.archivedAt != null,
      })),
    ]);
    await removeUnbackedCategoryChunks(tx, input.wikiId, propagated.categories);
    return { saved, propagated, cancelled, wasCurated: current.curationState === "curated" };
  });

  const pageIds = result.propagated.pages.map((page) => page.id);
  let projectionRefreshPending = await refreshDerivedState({
    wikiId: input.wikiId,
    pageIds,
    sourceIds: [result.saved.projection.id],
  });
  const queued = result.wasCurated
    ? await queueIncrementalKnowledgeBuild(
        input.wikiId,
        input.userId ?? null,
      ).catch(() => null)
    : null;
  if (result.wasCurated && !queued) projectionRefreshPending = true;
  return {
    source: result.saved.projection,
    revision: result.saved.revision,
    pageRevisions: result.propagated.revisions,
    signals: {
      queueIncrementalBuild: result.wasCurated,
      queueEmbeddingReindex: false,
      reindexPageIds: pageIds,
      reindexSourceIds: [result.saved.projection.id],
      cancelledBuilds: result.cancelled.cancelledBuilds,
      cancelledRuns: result.cancelled.cancelledRuns,
      projectionRefreshPending,
      ...(queued ? { queuedRunId: queued.runId, queuedBuildId: queued.buildId } : {}),
    },
  };
}

export interface RestoreSourceRevisionWithPropagationInput extends PolicyActorInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  revisionId: string;
}

/**
 * Source history restore의 content/policy/lifecycle/dependent Page 변화를 하나의 exclusive
 * transaction으로 커밋한다. 중간 downgrade/archive revision을 먼저 커밋하지 않으므로 뒤 단계
 * CAS 실패가 partial state를 남길 수 없다. dependent Page body를 재생성하지 않으므로 그
 * content provenance는 기존 SourceRevision을 보존하고 policy/lifecycle만 새 PageRevision에 기록한다.
 */
export async function restoreSourceRevisionWithPropagation(
  input: RestoreSourceRevisionWithPropagationInput,
): Promise<{
  source: Awaited<ReturnType<typeof restoreSourceRevisionTx>>["projection"];
  revision: SourceRevision;
  pageRevisions: PageRevision[];
  signals: PolicyQueueSignals;
}> {
  const now = new Date();
  const result = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const before = await tx.source.findFirst({
      where: { id: input.sourceId, wikiId: input.wikiId },
      select: { id: true, archivedAt: true },
    });
    if (!before) throw new ContentNotFoundError("source");

    const saved = await restoreSourceRevisionTx(tx, {
      wikiId: input.wikiId,
      sourceId: before.id,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      context: {
        actor: "restore",
        userId: input.userId ?? null,
        reason: input.reason ?? `source revision restored: ${input.revisionId}`,
      },
    });

    const pages: Awaited<ReturnType<typeof updatePageSnapshotTx>>["projection"][] = [];
    const revisions: PageRevision[] = [];
    const categories: string[] = [];
    const merge = (propagated: Awaited<ReturnType<typeof propagateSourcePages>>) => {
      pages.push(...propagated.pages);
      revisions.push(...propagated.revisions);
      categories.push(...propagated.categories);
    };

    // 현재 정책이 더 엄격하거나 선택 snapshot 자체가 internalOnly면 archived Page까지 strict-down한다.
    if (saved.projection.modelAccess === "internalOnly") {
      merge(await propagateSourcePages({
        tx,
        wikiId: input.wikiId,
        sourceId: saved.projection.id,
        sourceRevision: saved.revision,
        sourceModelAccess: saved.projection.modelAccess,
        mode: "downgrade",
        now,
        userId: input.userId,
        reason: `source revision restore kept internalOnly: ${input.revisionId}`,
        preserveExistingProvenance: true,
      }));
    }

    if (saved.projection.archivedAt) {
      // downgrade 뒤 다시 읽으므로 active note/generated Page는 최종 version에서 archive/stale된다.
      merge(await propagateSourcePages({
        tx,
        wikiId: input.wikiId,
        sourceId: saved.projection.id,
        sourceRevision: saved.revision,
        sourceModelAccess: saved.projection.modelAccess,
        mode: "archive",
        now,
        userId: input.userId,
        reason: `source revision restore selected archived snapshot: ${input.revisionId}`,
        preserveExistingProvenance: true,
      }));
    } else if (before.archivedAt) {
      // Source lifecycle archive가 만든 note만 되살린다. 사용자 suppression은 그대로 둔다.
      const archivedNotes = await tx.page.findMany({
        where: {
          wikiId: input.wikiId,
          sourceId: saved.projection.id,
          kind: "note",
          archivedAt: { not: null },
          suppressedAt: null,
        },
        select: {
          id: true,
          sourceId: true,
          currentVersion: true,
          origin: true,
          modelAccess: true,
          category: true,
          contributions: { where: { sourceId: saved.projection.id }, select: { id: true }, take: 1 },
          revisions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { version: true, actor: true, reason: true, buildId: true },
          },
        },
        orderBy: { id: "asc" },
      });
      const sourceLifecycleNotes = archivedNotes.filter((note) => {
        const currentRevision = note.revisions[0];
        return currentRevision?.version === note.currentVersion &&
          currentRevision.actor === "system" &&
          currentRevision.buildId === null &&
          (
            currentRevision.reason === SOURCE_ARCHIVE_REASON ||
            currentRevision.reason?.startsWith("source revision restore selected archived snapshot:")
          );
      });
      for (const note of sourceLifecycleNotes) {
        const restored = await updatePageSnapshotTx(tx, {
          wikiId: input.wikiId,
          pageId: note.id,
          expectedVersion: note.currentVersion,
          changes: { archivedAt: null, suppressedAt: null },
          // lifecycle만 복원하고 note 본문은 재생성하지 않는다. 그러므로 본문을 실제로 만든
          // 기존 SourceRevision provenance를 상속해야 하며, 선택 revision으로 갈아끼우면 안 된다.
          acceptedAiDraft: true,
          preserveOriginOnRestore: true,
          context: {
            actor: "restore",
            userId: input.userId ?? null,
            reason: `source restored: ${saved.projection.slug}`,
          },
        });
        pages.push(restored.projection);
        revisions.push(restored.revision);
        categories.push(...categoryPrefixes(restored.projection.category));
      }
    }

    const cancelled = saved.projection.modelAccess === "internalOnly" || saved.projection.archivedAt
      ? await cancelPendingModelWork(
          tx,
          input.wikiId,
          `source revision restore policy/lifecycle changed: ${input.revisionId}`,
          now,
        )
      : { cancelledBuilds: 0, cancelledRuns: 0 };

    // 같은 Page가 downgrade→archive로 두 번 전이됐으면 마지막 projection만 색인 정책에 사용한다.
    const currentPages = new Map<string, (typeof pages)[number]>();
    for (const page of pages) currentPages.set(page.id, page);
    await syncSearchChunkPolicy(tx, input.wikiId, [
      {
        refType: "source",
        refId: saved.projection.id,
        modelAccess: saved.projection.modelAccess,
        archived: saved.projection.archivedAt != null,
      },
      ...[...currentPages.values()].map((page) => ({
        refType: "page" as const,
        refId: page.id,
        modelAccess: page.modelAccess,
        archived: page.archivedAt != null,
      })),
    ]);
    await removeUnbackedCategoryChunks(tx, input.wikiId, categories);
    return { saved, pages: [...currentPages.values()], revisions, cancelled };
  });

  const pageIds = result.pages.map((page) => page.id);
  let projectionRefreshPending = await refreshDerivedState({
    wikiId: input.wikiId,
    pageIds,
    sourceIds: [result.saved.projection.id],
  });
  const shouldQueueExternalWork =
    result.saved.projection.archivedAt == null && result.saved.projection.modelAccess === "external";
  const queued = shouldQueueExternalWork
    ? await queueIncrementalKnowledgeBuild(
        input.wikiId,
        input.userId ?? null,
        result.saved.revision.id,
      ).catch(() => null)
    : null;
  if (shouldQueueExternalWork && !queued) projectionRefreshPending = true;
  if (shouldQueueExternalWork) {
    const embedded = await reindexEmbeddings(input.wikiId).catch(() => null);
    if (!embedded) projectionRefreshPending = true;
  }
  return {
    source: result.saved.projection,
    revision: result.saved.revision,
    pageRevisions: result.revisions,
    signals: {
      queueIncrementalBuild: shouldQueueExternalWork,
      queueEmbeddingReindex: shouldQueueExternalWork,
      reindexPageIds: pageIds,
      reindexSourceIds: [result.saved.projection.id],
      cancelledBuilds: result.cancelled.cancelledBuilds,
      cancelledRuns: result.cancelled.cancelledRuns,
      projectionRefreshPending,
      ...(queued ? { queuedRunId: queued.runId, queuedBuildId: queued.buildId } : {}),
    },
  };
}
