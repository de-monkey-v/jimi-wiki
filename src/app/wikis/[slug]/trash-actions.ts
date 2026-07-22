"use server";

import { revalidatePath } from "next/cache";
import { hasRole } from "@/lib/api-gate";
import { processBlobPurgeLog } from "@/lib/blob-purge";
import { purgePage, purgeSource } from "@/lib/content-store";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { restoreSavedLink } from "@/lib/saved-links";
import { restoreTrashedPage, restoreTrashedSource } from "@/lib/trash";

async function requireWiki(wikiSlug: string, role: "viewer" | "editor" | "owner") {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki || !hasRole(wiki.role, role)) throw new Error(`${role} 권한이 필요합니다`);
  return { userId, wiki };
}

const refreshTrash = (wikiSlug: string) => {
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  revalidatePath(`/wikis/${wikiSlug}/settings/trash`);
  revalidatePath(`/wikis/${wikiSlug}/reading`);
};

export async function restoreSavedLinkFromTrashAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const { userId, wiki } = await requireWiki(wikiSlug, "viewer");
  await restoreSavedLink(wiki.id, userId, String(formData.get("id") ?? ""));
  refreshTrash(wikiSlug);
}

export async function restorePageFromTrashAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const slug = String(formData.get("slug") ?? "");
  const { userId, wiki } = await requireWiki(wikiSlug, "editor");
  const page = await prisma.page.findFirst({ where: { wikiId: wiki.id, slug, trashedAt: { not: null } } });
  if (!page) throw new Error("페이지를 찾을 수 없습니다");
  await restoreTrashedPage({ wikiId: wiki.id, pageId: page.id, expectedVersion: page.currentVersion, userId });
  refreshTrash(wikiSlug);
}

export async function restoreSourceFromTrashAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const slug = String(formData.get("slug") ?? "");
  const { userId, wiki } = await requireWiki(wikiSlug, "editor");
  const source = await prisma.source.findFirst({ where: { wikiId: wiki.id, slug, trashedAt: { not: null } } });
  if (!source) throw new Error("원문을 찾을 수 없습니다");
  await restoreTrashedSource({ wikiId: wiki.id, sourceId: source.id, expectedVersion: source.currentVersion, userId });
  refreshTrash(wikiSlug);
}

function requireConfirmation(formData: FormData, expected: string) {
  if (String(formData.get("confirm") ?? "") !== expected) throw new Error("확인 문자열이 일치하지 않습니다");
}

export async function purgeSavedLinkAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const id = String(formData.get("id") ?? "");
  requireConfirmation(formData, id);
  const { userId, wiki } = await requireWiki(wikiSlug, "owner");
  await prisma.savedLink.deleteMany({ where: { id, wikiId: wiki.id, userId, trashedAt: { not: null } } });
  refreshTrash(wikiSlug);
}

export async function purgePageFromTrashAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const slug = String(formData.get("slug") ?? "");
  requireConfirmation(formData, slug);
  const { wiki } = await requireWiki(wikiSlug, "owner");
  const page = await prisma.page.findFirst({ where: { wikiId: wiki.id, slug, trashedAt: { not: null } } });
  if (!page) throw new Error("페이지를 찾을 수 없습니다");
  await purgePage({ wikiId: wiki.id, pageId: page.id, expectedVersion: page.currentVersion });
  refreshTrash(wikiSlug);
}

export async function purgeSourceFromTrashAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug") ?? "");
  const slug = String(formData.get("slug") ?? "");
  requireConfirmation(formData, slug);
  const { wiki } = await requireWiki(wikiSlug, "owner");
  const source = await prisma.source.findFirst({ where: { wikiId: wiki.id, slug, trashedAt: { not: null } } });
  if (!source) throw new Error("원문을 찾을 수 없습니다");
  const purged = await purgeSource({ wikiId: wiki.id, sourceId: source.id, expectedVersion: source.currentVersion });
  if (purged.cleanupLogId) await processBlobPurgeLog(purged.cleanupLogId).catch(() => null);
  refreshTrash(wikiSlug);
}
