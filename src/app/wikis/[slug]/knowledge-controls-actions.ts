"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hasRole } from "@/lib/api-gate";
import { processBlobPurgeLog } from "@/lib/blob-purge";
import { queueIncrementalKnowledgeBuild } from "@/lib/builds";
import {
  ContentVersionConflictError,
  archivePageSnapshotTx,
  purgePage,
  purgeSource,
  restoreArchivedPageTx,
  restoreArchivedSourceTx,
} from "@/lib/content-store";
import { prisma } from "@/lib/db";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import { archiveSourceWithPropagation, changePageModelAccess, changeSourceModelAccess } from "@/lib/model-policy";
import { refreshPageDerivedState, refreshSourceDerivedState } from "@/lib/page-projections";
import {
  PageSourcePromotionNotAllowedError,
  promotePageSnapshotToSource,
} from "@/lib/page-source-promotion.server";
import { isReservedSlug } from "@/lib/ontology";
import { reindexEmbeddings } from "@/lib/search";
import { getCurrentUser } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import type { ModelAccess, Role } from "@/generated/prisma/client";

export type KnowledgeControlState = {
  status: "idle" | "success" | "error";
  code?: "versionConflict" | "confirmationRequired" | "notEligible" | "failed";
  currentVersion?: number;
  sourceSlug?: string;
  buildId?: string | null;
};

function expectedVersion(formData: FormData): number {
  const value = Number(formData.get("expectedVersion"));
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid expected version");
  return value;
}

function requestedAccess(formData: FormData): ModelAccess {
  const value = String(formData.get("modelAccess") ?? "");
  if (value !== "external" && value !== "internalOnly") throw new Error("invalid model access");
  return value;
}

async function requireRole(wikiSlug: string, minRole: Role) {
  const user = await getCurrentUser();
  if (!user) throw new Error("authentication required");
  const wiki = await getWikiForUser(user.id, wikiSlug);
  if (!wiki) throw new Error("wiki not found");
  if (!hasRole(wiki.role, minRole)) throw new Error(`${minRole} role required`);
  return { user, wiki };
}

function failure(error: unknown): KnowledgeControlState {
  if (error instanceof ContentVersionConflictError) return { status: "error", code: "versionConflict" };
  if (error instanceof PageSourcePromotionNotAllowedError) return { status: "error", code: "notEligible" };
  if (error instanceof Error && error.name === "ContentPolicyRelaxationError") {
    return { status: "error", code: "confirmationRequired" };
  }
  return { status: "error", code: "failed" };
}

export async function promotePageToSourceAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const pageSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const result = await promotePageSnapshotToSource({
      wikiId: wiki.id,
      pageSlug,
      expectedVersion: expectedVersion(formData),
      userId: user.id,
    });
    revalidateResource(wikiSlug, "page", pageSlug);
    revalidateResource(wikiSlug, "source", result.sourceSlug);
    revalidatePath(`/wikis/${wikiSlug}/builds`);
    return {
      status: "success",
      currentVersion: expectedVersion(formData),
      sourceSlug: result.sourceSlug,
      buildId: result.buildId,
    };
  } catch (error) {
    return failure(error);
  }
}

function revalidateResource(wikiSlug: string, type: "page" | "source", resourceSlug: string) {
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  revalidatePath(
    type === "page"
      ? `/wikis/${wikiSlug}/${resourceSlug}`
      : `/wikis/${wikiSlug}/sources/${resourceSlug}`,
  );
}

export async function changePagePolicyAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const pageSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const page = await prisma.page.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: pageSlug } },
      select: { id: true },
    });
    if (!page) throw new Error("page not found");
    const result = await changePageModelAccess({
      wikiId: wiki.id,
      pageId: page.id,
      expectedVersion: expectedVersion(formData),
      modelAccess: requestedAccess(formData),
      confirmExternalAccess: formData.get("confirmExternalAccess") === "on",
      userId: user.id,
      reason: "page policy changed in private UI",
    });
    revalidateResource(wikiSlug, "page", pageSlug);
    return { status: "success", currentVersion: result.page.currentVersion };
  } catch (error) {
    return failure(error);
  }
}

export async function changeSourcePolicyAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const sourceSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const source = await prisma.source.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } },
      select: { id: true },
    });
    if (!source) throw new Error("source not found");
    const result = await changeSourceModelAccess({
      wikiId: wiki.id,
      sourceId: source.id,
      expectedVersion: expectedVersion(formData),
      modelAccess: requestedAccess(formData),
      confirmExternalAccess: formData.get("confirmExternalAccess") === "on",
      userId: user.id,
      reason: "source policy changed in private UI",
    });
    revalidateResource(wikiSlug, "source", sourceSlug);
    return { status: "success", currentVersion: result.source.currentVersion };
  } catch (error) {
    return failure(error);
  }
}

export async function archivePageAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const pageSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const page = await prisma.page.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: pageSlug } },
      select: { id: true, archivedAt: true, origin: true },
    });
    if (!page || page.archivedAt || page.origin === "system" || isReservedSlug(pageSlug)) throw new Error("page not active");
    const saved = await withModelPolicyWriteLock(wiki.id, (tx) => archivePageSnapshotTx(tx, {
      wikiId: wiki.id,
      pageId: page.id,
      expectedVersion: expectedVersion(formData),
      suppression: true,
      context: { actor: "human", userId: user.id, reason: "page archived in private UI" },
    }));
    await refreshPageDerivedState(wiki.id, saved.page.id);
    revalidateResource(wikiSlug, "page", pageSlug);
    return { status: "success", currentVersion: saved.page.currentVersion };
  } catch (error) {
    return failure(error);
  }
}

export async function restorePageAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const pageSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const page = await prisma.page.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: pageSlug } },
      select: { id: true, archivedAt: true, origin: true },
    });
    if (!page?.archivedAt || page.origin === "system" || isReservedSlug(pageSlug)) throw new Error("page not archived");
    const saved = await withModelPolicyWriteLock(wiki.id, (tx) => restoreArchivedPageTx(tx, {
      wikiId: wiki.id,
      pageId: page.id,
      expectedVersion: expectedVersion(formData),
      context: { actor: "restore", userId: user.id, reason: "page restored in private UI" },
    }));
    await refreshPageDerivedState(wiki.id, saved.page.id);
    if (saved.page.modelAccess === "external" && saved.page.kind !== "personal") {
      await reindexEmbeddings(wiki.id).catch(() => null);
    }
    revalidateResource(wikiSlug, "page", pageSlug);
    return { status: "success", currentVersion: saved.page.currentVersion };
  } catch (error) {
    return failure(error);
  }
}

export async function archiveSourceAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const sourceSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const source = await prisma.source.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } },
      select: { id: true, archivedAt: true },
    });
    if (!source || source.archivedAt) throw new Error("source not active");
    const result = await archiveSourceWithPropagation({
      wikiId: wiki.id,
      sourceId: source.id,
      expectedVersion: expectedVersion(formData),
      userId: user.id,
      reason: "source archived in private UI",
    });
    revalidateResource(wikiSlug, "source", sourceSlug);
    return { status: "success", currentVersion: result.source.currentVersion };
  } catch (error) {
    return failure(error);
  }
}

export async function restoreSourceAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const sourceSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { user, wiki } = await requireRole(wikiSlug, "editor");
    const result = await withModelPolicyWriteLock(wiki.id, async (tx) => {
      const source = await tx.source.findUnique({
        where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } },
        select: { id: true, archivedAt: true },
      });
      if (!source?.archivedAt) throw new Error("source not archived");
      const restoredSource = await restoreArchivedSourceTx(tx, {
        wikiId: wiki.id,
        sourceId: source.id,
        expectedVersion: expectedVersion(formData),
        context: { actor: "restore", userId: user.id, reason: "source restored in private UI" },
      });
      const notes = await tx.page.findMany({
        where: { wikiId: wiki.id, sourceId: source.id, kind: "note", archivedAt: { not: null }, suppressedAt: null },
        select: { id: true, currentVersion: true },
      });
      const pageIds: string[] = [];
      for (const note of notes) {
        const restored = await restoreArchivedPageTx(tx, {
          wikiId: wiki.id,
          pageId: note.id,
          expectedVersion: note.currentVersion,
          context: { actor: "restore", userId: user.id, reason: `source restored: ${sourceSlug}` },
        });
        pageIds.push(restored.page.id);
      }
      return { source: restoredSource.source, revision: restoredSource.revision, pageIds };
    });
    await Promise.all([
      refreshSourceDerivedState(wiki.id, result.source.id),
      ...result.pageIds.map((pageId) => refreshPageDerivedState(wiki.id, pageId)),
    ]);
    if (result.source.modelAccess === "external") {
      await queueIncrementalKnowledgeBuild(wiki.id, user.id, result.revision.id).catch(() => null);
      await reindexEmbeddings(wiki.id).catch(() => null);
    }
    revalidateResource(wikiSlug, "source", sourceSlug);
    return { status: "success", currentVersion: result.source.currentVersion };
  } catch (error) {
    return failure(error);
  }
}

export async function purgePageAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const pageSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { wiki } = await requireRole(wikiSlug, "owner");
    if (String(formData.get("confirmSlug") ?? "") !== pageSlug) {
      return { status: "error", code: "confirmationRequired" };
    }
    if (isReservedSlug(pageSlug)) throw new Error("system page cannot be purged");
    const page = await prisma.page.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: pageSlug } },
      select: { id: true, origin: true },
    });
    if (!page || page.origin === "system") throw new Error("page not found");
    await purgePage({ wikiId: wiki.id, pageId: page.id, expectedVersion: expectedVersion(formData) });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
}

export async function purgeSourceAction(
  _previous: KnowledgeControlState,
  formData: FormData,
): Promise<KnowledgeControlState> {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const sourceSlug = String(formData.get("resourceSlug") ?? "");
  try {
    const { wiki } = await requireRole(wikiSlug, "owner");
    if (String(formData.get("confirmSlug") ?? "") !== sourceSlug) {
      return { status: "error", code: "confirmationRequired" };
    }
    const source = await prisma.source.findUnique({
      where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } },
      select: { id: true },
    });
    if (!source) throw new Error("source not found");
    const purged = await purgeSource({ wikiId: wiki.id, sourceId: source.id, expectedVersion: expectedVersion(formData) });
    if (purged.cleanupLogId) await processBlobPurgeLog(purged.cleanupLogId).catch(() => null);
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
}
