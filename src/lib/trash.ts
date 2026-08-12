import "server-only";

import { prisma } from "@/lib/db";
import {
  ContentNotFoundError,
  ContentVersionConflictError,
  archivePageSnapshotTx,
  purgePageTx,
  purgeSourceTx,
  restoreArchivedPageTx,
  restoreArchivedSourceTx,
  setPageTrashStateTx,
  setSourceTrashStateTx,
} from "@/lib/content-store";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import { archiveSourceWithPropagation } from "@/lib/model-policy";
import { refreshPageDerivedState, refreshSourceDerivedState } from "@/lib/page-projections";
import { reindexEmbeddings } from "@/lib/search";
import { queueIncrementalKnowledgeBuild } from "@/lib/builds";
import { getBlobStore } from "@/lib/blob";
import { isPageTrashEligible } from "@/lib/kinds";

export const TRASH_RETENTION_DAYS = 14;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export function trashPurgeAt(trashedAt: Date): Date {
  return new Date(trashedAt.getTime() + TRASH_RETENTION_MS);
}

export async function trashPage(input: {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  userId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const page = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const current = await tx.page.findFirst({
      where: { id: input.pageId, wikiId: input.wikiId },
      select: {
        id: true,
        slug: true,
        kind: true,
        origin: true,
        sourceId: true,
        currentVersion: true,
        archivedAt: true,
        trashedAt: true,
      },
    });
    if (!current) throw new ContentNotFoundError("page");
    if (current.trashedAt) return tx.page.findUniqueOrThrow({ where: { id: current.id } });
    if (current.currentVersion !== input.expectedVersion) {
      throw new ContentVersionConflictError(input.expectedVersion, current.currentVersion);
    }
    if (current.origin === "system") throw new Error("system_page_cannot_be_trashed");
    if (current.kind === "note" && current.sourceId) throw new Error("source_note_requires_source_trash");

    if (!current.archivedAt) {
      await archivePageSnapshotTx(tx, {
        wikiId: input.wikiId,
        pageId: current.id,
        expectedVersion: current.currentVersion,
        archivedAt: now,
        suppression: true,
        context: { actor: "human", userId: input.userId, reason: "page moved to trash" },
      });
    }
    return setPageTrashStateTx(tx, {
      wikiId: input.wikiId,
      pageId: current.id,
      trashedAt: now,
      purgeAt: trashPurgeAt(now),
      archivedBeforeTrash: current.archivedAt !== null,
    });
  });
  await refreshPageDerivedState(input.wikiId, page.id);
  return page;
}

export const MAX_TOC_BULK_TRASH_PAGES = 1_000;

export type TocBulkTrashRequest = { slug: string; expectedVersion: number };
export type TocBulkTrashOutcome =
  | "trashed"
  | "alreadyTrashed"
  | "versionConflict"
  | "notEligible"
  | "notFound"
  | "failed"
  | "notAttempted";
export type TocBulkTrashItemResult = {
  slug: string;
  outcome: TocBulkTrashOutcome;
  actualVersion?: number;
  cleanupPending?: boolean;
};
export type TocBulkTrashResult = {
  status: "success" | "partial" | "error";
  code?: "invalidInput" | "failed" | "uncertain";
  movedCount: number;
  failedCount: number;
  warningCount: number;
  items: TocBulkTrashItemResult[];
};

function parseTocBulkTrashRequests(raw: unknown): TocBulkTrashRequest[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOC_BULK_TRASH_PAGES) return null;
  const versions = new Map<string, number>();
  for (const value of raw) {
    if (!value || typeof value !== "object") return null;
    const slug = (value as { slug?: unknown }).slug;
    const expectedVersion = (value as { expectedVersion?: unknown }).expectedVersion;
    if (
      typeof slug !== "string" ||
      slug.length === 0 ||
      slug.length > 512 ||
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      return null;
    }
    const previous = versions.get(slug);
    if (previous !== undefined && previous !== expectedVersion) return null;
    versions.set(slug, expectedVersion);
  }
  return [...versions].map(([slug, expectedVersion]) => ({ slug, expectedVersion }));
}

function tocBulkTrashResult(items: TocBulkTrashItemResult[], invalidInput = false): TocBulkTrashResult {
  const movedCount = items.filter((item) => item.outcome === "trashed" || item.outcome === "alreadyTrashed").length;
  const failedCount = items.length - movedCount;
  const warningCount = items.filter((item) => item.cleanupPending).length;
  const uncertain = items.some((item) => item.outcome === "failed");
  return {
    status: invalidInput || movedCount === 0 ? "error" : failedCount > 0 || warningCount > 0 ? "partial" : "success",
    ...(invalidInput ? { code: "invalidInput" as const } : uncertain ? { code: "uncertain" as const } : {}),
    movedCount,
    failedCount,
    warningCount,
    items,
  };
}

/**
 * WikiToc 일괄 이동 코어. 요청은 한 번 받되 기존 단건 trashPage 경계를 항목별로 재사용한다.
 * 한 문서의 stale version이 나머지 복구 가능한 이동을 막지 않으며, 결과를 slug별로 돌려줘
 * 실패 항목만 최신 버전으로 다시 시도할 수 있다.
 */
export async function trashPagesFromToc(input: {
  wikiId: string;
  userId: string;
  items: unknown;
  now?: Date;
}): Promise<TocBulkTrashResult> {
  const requests = parseTocBulkTrashRequests(input.items);
  if (!requests) return tocBulkTrashResult([], true);
  const now = input.now ?? new Date();
  const results: TocBulkTrashItemResult[] = [];

  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    try {
      const page = await prisma.page.findUnique({
        where: { wikiId_slug: { wikiId: input.wikiId, slug: request.slug } },
        select: {
          id: true,
          slug: true,
          kind: true,
          origin: true,
          sourceId: true,
          currentVersion: true,
          archivedAt: true,
          trashedAt: true,
        },
      });
      if (!page) {
        results.push({ slug: request.slug, outcome: "notFound" });
        continue;
      }
      if (page.trashedAt) {
        let cleanupPending = false;
        try {
          await refreshPageDerivedState(input.wikiId, page.id);
        } catch {
          cleanupPending = true;
        }
        results.push({ slug: request.slug, outcome: "alreadyTrashed", cleanupPending });
        continue;
      }
      if (page.archivedAt || !isPageTrashEligible(page)) {
        results.push({ slug: request.slug, outcome: "notEligible" });
        continue;
      }
      if (page.currentVersion !== request.expectedVersion) {
        results.push({ slug: request.slug, outcome: "versionConflict", actualVersion: page.currentVersion });
        continue;
      }
      await trashPage({
        wikiId: input.wikiId,
        pageId: page.id,
        expectedVersion: request.expectedVersion,
        userId: input.userId,
        now,
      });
      results.push({ slug: request.slug, outcome: "trashed" });
    } catch (error) {
      if (error instanceof ContentVersionConflictError) {
        results.push({ slug: request.slug, outcome: "versionConflict", actualVersion: error.actualVersion });
        continue;
      }
      if (error instanceof ContentNotFoundError) {
        results.push({ slug: request.slug, outcome: "notFound" });
        continue;
      }
      if (error instanceof Error && ["system_page_cannot_be_trashed", "source_note_requires_source_trash"].includes(error.message)) {
        results.push({ slug: request.slug, outcome: "notEligible" });
        continue;
      }

      // archive/trash commit 뒤 projection refresh만 실패했을 수 있다. 실제 row를 다시 읽어
      // 성공을 실패로 오보하지 않고 cleanup을 한 번 재시도한다.
      try {
        const committed = await prisma.page.findUnique({
          where: { wikiId_slug: { wikiId: input.wikiId, slug: request.slug } },
          select: { id: true, trashedAt: true },
        });
        if (committed?.trashedAt) {
          let cleanupPending = false;
          try {
            await refreshPageDerivedState(input.wikiId, committed.id);
          } catch {
            cleanupPending = true;
          }
          results.push({ slug: request.slug, outcome: "trashed", cleanupPending });
          continue;
        }
      } catch {
        // authoritative read도 실패하면 아래에서 현재 항목과 미시도 항목을 구분해 반환한다.
      }
      results.push({ slug: request.slug, outcome: "failed" });
      for (const remaining of requests.slice(index + 1)) {
        results.push({ slug: remaining.slug, outcome: "notAttempted" });
      }
      break;
    }
  }

  return tocBulkTrashResult(results);
}

export async function restoreTrashedPage(input: {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  userId: string;
}) {
  const page = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const current = await tx.page.findFirst({
      where: { id: input.pageId, wikiId: input.wikiId },
      select: {
        id: true,
        currentVersion: true,
        archivedAt: true,
        archivedBeforeTrash: true,
        trashedAt: true,
      },
    });
    if (!current) throw new ContentNotFoundError("page");
    if (!current.trashedAt) return tx.page.findUniqueOrThrow({ where: { id: current.id } });
    if (current.currentVersion !== input.expectedVersion) {
      throw new ContentVersionConflictError(input.expectedVersion, current.currentVersion);
    }
    if (current.archivedBeforeTrash) {
      return setPageTrashStateTx(tx, {
        wikiId: input.wikiId,
        pageId: current.id,
        trashedAt: null,
        purgeAt: null,
        archivedBeforeTrash: false,
      });
    }
    if (!current.archivedAt) throw new Error("trashed_page_not_archived");
    const restored = await restoreArchivedPageTx(tx, {
      wikiId: input.wikiId,
      pageId: current.id,
      expectedVersion: current.currentVersion,
      context: { actor: "restore", userId: input.userId, reason: "page restored from trash" },
    });
    return setPageTrashStateTx(tx, {
      wikiId: input.wikiId,
      pageId: restored.projection.id,
      trashedAt: null,
      purgeAt: null,
      archivedBeforeTrash: false,
    });
  });
  await refreshPageDerivedState(input.wikiId, page.id);
  if (!page.archivedAt && page.modelAccess === "external" && page.kind !== "personal") {
    await reindexEmbeddings(input.wikiId).catch(() => null);
  }
  return page;
}

export async function trashSource(input: {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  userId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const current = await prisma.source.findFirst({
    where: { id: input.sourceId, wikiId: input.wikiId },
    select: { id: true, currentVersion: true, archivedAt: true, trashedAt: true },
  });
  if (!current) throw new ContentNotFoundError("source");
  if (current.trashedAt) return prisma.source.findUniqueOrThrow({ where: { id: current.id } });
  if (current.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, current.currentVersion);
  }
  if (!current.archivedAt) {
    const result = await archiveSourceWithPropagation({
      wikiId: input.wikiId,
      sourceId: current.id,
      expectedVersion: current.currentVersion,
      userId: input.userId,
      reason: "source moved to trash",
      trash: { trashedAt: now, purgeAt: trashPurgeAt(now), archivedBeforeTrash: false },
    });
    return result.source;
  }
  return withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const locked = await tx.source.findFirst({ where: { id: current.id, wikiId: input.wikiId } });
    if (!locked) throw new ContentNotFoundError("source");
    if (locked.currentVersion !== input.expectedVersion) {
      throw new ContentVersionConflictError(input.expectedVersion, locked.currentVersion);
    }
    return setSourceTrashStateTx(tx, {
      wikiId: input.wikiId,
      sourceId: locked.id,
      trashedAt: now,
      purgeAt: trashPurgeAt(now),
      archivedBeforeTrash: true,
    });
  });
}

export async function restoreTrashedSource(input: {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  userId: string;
}) {
  const result = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const source = await tx.source.findFirst({
      where: { id: input.sourceId, wikiId: input.wikiId },
      select: {
        id: true,
        slug: true,
        currentVersion: true,
        archivedAt: true,
        archivedBeforeTrash: true,
        trashedAt: true,
      },
    });
    if (!source) throw new ContentNotFoundError("source");
    if (!source.trashedAt) {
      return { source: await tx.source.findUniqueOrThrow({ where: { id: source.id } }), pageIds: [] as string[] };
    }
    if (source.currentVersion !== input.expectedVersion) {
      throw new ContentVersionConflictError(input.expectedVersion, source.currentVersion);
    }
    if (source.archivedBeforeTrash) {
      const restored = await setSourceTrashStateTx(tx, {
        wikiId: input.wikiId,
        sourceId: source.id,
        trashedAt: null,
        purgeAt: null,
        archivedBeforeTrash: false,
      });
      return { source: restored, pageIds: [] as string[] };
    }
    if (!source.archivedAt) throw new Error("trashed_source_not_archived");
    const restoredSource = await restoreArchivedSourceTx(tx, {
      wikiId: input.wikiId,
      sourceId: source.id,
      expectedVersion: source.currentVersion,
      context: { actor: "restore", userId: input.userId, reason: "source restored from trash" },
    });
    const notes = await tx.page.findMany({
      where: {
        wikiId: input.wikiId,
        sourceId: source.id,
        kind: "note",
        archivedAt: { not: null },
        suppressedAt: null,
      },
      select: { id: true, currentVersion: true },
    });
    const pageIds: string[] = [];
    for (const note of notes) {
      const restored = await restoreArchivedPageTx(tx, {
        wikiId: input.wikiId,
        pageId: note.id,
        expectedVersion: note.currentVersion,
        context: { actor: "restore", userId: input.userId, reason: `source restored from trash: ${source.slug}` },
      });
      pageIds.push(restored.projection.id);
    }
    const restored = await setSourceTrashStateTx(tx, {
      wikiId: input.wikiId,
      sourceId: restoredSource.projection.id,
      trashedAt: null,
      purgeAt: null,
      archivedBeforeTrash: false,
    });
    return { source: restored, pageIds };
  });

  await Promise.all([
    refreshSourceDerivedState(input.wikiId, result.source.id),
    ...result.pageIds.map((pageId) => refreshPageDerivedState(input.wikiId, pageId)),
  ]);
  if (!result.source.archivedAt && result.source.modelAccess === "external") {
    await queueIncrementalKnowledgeBuild(input.wikiId, input.userId).catch(() => null);
    await reindexEmbeddings(input.wikiId).catch(() => null);
  }
  return result.source;
}

export async function trashWiki(input: { wikiId: string; slug: string; userId: string; now?: Date }) {
  const now = input.now ?? new Date();
  return withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const wiki = await tx.wiki.findUnique({ where: { id: input.wikiId } });
    if (!wiki || wiki.slug !== input.slug) throw new Error("wiki_confirmation_mismatch");
    if (wiki.trashedAt) return wiki;
    await tx.agentRun.updateMany({
      where: { wikiId: wiki.id, status: { in: ["pending", "running"] } },
      data: { status: "error", stage: null, error: "wiki moved to trash", finishedAt: now },
    });
    await tx.knowledgeBuild.updateMany({
      where: { wikiId: wiki.id, status: { in: ["pending", "running"] } },
      data: { status: "cancelled", error: { reason: "wiki moved to trash" }, finishedAt: now },
    });
    return tx.wiki.update({
      where: { id: wiki.id },
      data: { trashedAt: now, purgeAt: trashPurgeAt(now) },
    });
  });
}

export async function restoreTrashedWiki(wikiId: string) {
  const wiki = await prisma.wiki.findUnique({ where: { id: wikiId } });
  if (!wiki) throw new Error("wiki_not_found");
  if (!wiki.trashedAt) return wiki;
  return prisma.wiki.update({ where: { id: wiki.id }, data: { trashedAt: null, purgeAt: null } });
}

export async function purgeTrashedWiki(wikiId: string, now = new Date(), force = false) {
  const deleted = await prisma.$transaction(async (tx) => {
    const wiki = await tx.wiki.findUnique({
      where: { id: wikiId },
      select: { id: true, slug: true, trashedAt: true, purgeAt: true },
    });
    if (!wiki?.purgeAt || (!force && wiki.purgeAt > now)) return null;
    const removed = await tx.wiki.deleteMany({
      where: {
        id: wiki.id,
        trashedAt: { not: null },
        purgeAt: force ? { not: null } : { lte: now },
      },
    });
    return removed.count === 1 ? { id: wiki.id, slug: wiki.slug } : null;
  });
  if (deleted) await getBlobStore().deletePrefix(`${deleted.id}/`).catch(() => null);
  return deleted;
}

export async function purgeExpiredTrash(now = new Date(), batchSize = 50) {
  const [savedLinks, pages, sources, wikis] = await Promise.all([
    prisma.savedLink.findMany({
      where: { purgeAt: { lte: now }, trashedAt: { not: null } },
      select: { id: true },
      orderBy: { purgeAt: "asc" },
      take: batchSize,
    }),
    prisma.page.findMany({
      where: { purgeAt: { lte: now }, trashedAt: { not: null } },
      select: { id: true, wikiId: true },
      orderBy: { purgeAt: "asc" },
      take: batchSize,
    }),
    prisma.source.findMany({
      where: { purgeAt: { lte: now }, trashedAt: { not: null } },
      select: { id: true, wikiId: true },
      orderBy: { purgeAt: "asc" },
      take: batchSize,
    }),
    prisma.wiki.findMany({
      where: { purgeAt: { lte: now }, trashedAt: { not: null } },
      select: { id: true },
      orderBy: { purgeAt: "asc" },
      take: batchSize,
    }),
  ]);
  const counts = { savedLinks: 0, pages: 0, sources: 0, wikis: 0, failed: 0 };

  for (const link of savedLinks) {
    try {
      const deleted = await prisma.savedLink.deleteMany({ where: { id: link.id, purgeAt: { lte: now }, trashedAt: { not: null } } });
      counts.savedLinks += deleted.count;
    } catch {
      counts.failed += 1;
    }
  }
  for (const pageRef of pages) {
    try {
      const deleted = await withModelPolicyWriteLock(pageRef.wikiId, async (tx) => {
        const page = await tx.page.findFirst({
          where: { id: pageRef.id, wikiId: pageRef.wikiId, purgeAt: { lte: now }, trashedAt: { not: null } },
          select: { currentVersion: true },
        });
        if (!page) return false;
        await purgePageTx(tx, { wikiId: pageRef.wikiId, pageId: pageRef.id, expectedVersion: page.currentVersion });
        return true;
      });
      if (deleted) counts.pages += 1;
    } catch {
      counts.failed += 1;
    }
  }
  for (const sourceRef of sources) {
    try {
      const deleted = await withModelPolicyWriteLock(sourceRef.wikiId, async (tx) => {
        const source = await tx.source.findFirst({
          where: { id: sourceRef.id, wikiId: sourceRef.wikiId, purgeAt: { lte: now }, trashedAt: { not: null } },
          select: { currentVersion: true },
        });
        if (!source) return false;
        await purgeSourceTx(tx, { wikiId: sourceRef.wikiId, sourceId: sourceRef.id, expectedVersion: source.currentVersion });
        return true;
      });
      if (deleted) counts.sources += 1;
    } catch {
      counts.failed += 1;
    }
  }
  for (const wiki of wikis) {
    try {
      if (await purgeTrashedWiki(wiki.id, now)) counts.wikis += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}
