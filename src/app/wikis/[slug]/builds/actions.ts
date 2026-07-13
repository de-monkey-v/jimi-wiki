"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { hasRole } from "@/lib/api-gate";
import {
  acceptKnowledgeDraft,
  createRebuildRun,
  rejectKnowledgeDraft,
  retryKnowledgeBuildIndexes,
  restoreKnowledgeBuild,
} from "@/lib/builds";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/ratelimit";
import { getCurrentUser } from "@/lib/session";
import { checkDailyQuota } from "@/lib/usage";
import { getWikiForUser } from "@/lib/wiki";
import type { Role } from "@/generated/prisma/client";

async function requireRole(wikiSlug: string, role: Role) {
  const user = await getCurrentUser();
  if (!user) throw new Error("authentication required");
  const wiki = await getWikiForUser(user.id, wikiSlug);
  if (!wiki) throw new Error("wiki not found");
  if (!hasRole(wiki.role, role)) throw new Error(`${role} role required`);
  return { user, wiki };
}

async function requireBuild(wikiId: string, buildId: string) {
  const build = await prisma.knowledgeBuild.findFirst({
    where: { id: buildId, wikiId },
    select: { id: true, restorable: true },
  });
  if (!build) throw new Error("build not found");
  return build;
}

export async function startRebuildAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const { user, wiki } = await requireRole(wikiSlug, "owner");
  const rate = checkRateLimit(`session:${user.id}`);
  if (!rate.ok) throw new Error(`rate limit exceeded; retry after ${rate.retryAfter}s`);
  const quota = await checkDailyQuota(user.id);
  if (!quota.ok) throw new Error("daily generation quota exceeded");
  const forceExtraction = formData.get("forceExtraction") === "on";
  const result = await createRebuildRun(wiki.id, user.id, { mode: "full", forceExtraction });
  revalidatePath(`/wikis/${wikiSlug}/builds`);
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/builds/${encodeURIComponent(result.buildId)}`);
}

export async function acceptDraftAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const buildId = String(formData.get("buildId") ?? "");
  const draftId = String(formData.get("draftId") ?? "");
  const { user, wiki } = await requireRole(wikiSlug, "editor");
  await requireBuild(wiki.id, buildId);
  await acceptKnowledgeDraft(buildId, draftId, user.id);
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  revalidatePath(`/wikis/${wikiSlug}/builds`);
  revalidatePath(`/wikis/${wikiSlug}/builds/${buildId}`);
}

export async function rejectDraftAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const buildId = String(formData.get("buildId") ?? "");
  const draftId = String(formData.get("draftId") ?? "");
  const { wiki } = await requireRole(wikiSlug, "editor");
  await requireBuild(wiki.id, buildId);
  await rejectKnowledgeDraft(buildId, draftId);
  revalidatePath(`/wikis/${wikiSlug}/builds`);
  revalidatePath(`/wikis/${wikiSlug}/builds/${buildId}`);
}

export async function restoreBuildAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const buildId = String(formData.get("buildId") ?? "");
  const { user, wiki } = await requireRole(wikiSlug, "owner");
  const build = await requireBuild(wiki.id, buildId);
  if (!build.restorable) throw new Error("build is not restorable");
  const result = await restoreKnowledgeBuild(buildId, user.id);
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  revalidatePath(`/wikis/${wikiSlug}/builds`);
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/builds/${encodeURIComponent(result.restoreBuildId)}`);
}

export async function retryIndexesAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const buildId = String(formData.get("buildId") ?? "");
  const { wiki } = await requireRole(wikiSlug, "editor");
  await requireBuild(wiki.id, buildId);
  await retryKnowledgeBuildIndexes(buildId);
  revalidatePath(`/wikis/${wikiSlug}/builds`);
  revalidatePath(`/wikis/${wikiSlug}/builds/${buildId}`);
}
