"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, updateWikiSettings, deleteWiki } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { inviteMember, updateMemberRole, removeMember, createShareLink, revokeShareLink } from "@/lib/members";
import type { Role, Visibility } from "@/generated/prisma/client";

async function requireOwner(userId: string, wikiSlug: string) {
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  if (!hasRole(wiki.role, "owner")) throw new Error("owner만 가능합니다");
  return wiki;
}

const settingsPath = (slug: string) => `/wikis/${encodeURIComponent(slug)}/settings`;

export async function updateWikiSettingsAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await updateWikiSettings(wiki.id, {
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    visibility: String(formData.get("visibility") ?? "private") as Visibility,
  });
  revalidatePath(`/wikis/${wikiSlug}/settings`);
  redirect(settingsPath(wikiSlug));
}

export async function deleteWikiAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await deleteWiki(wiki.id);
  redirect("/wikis");
}

export async function inviteMemberAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await inviteMember(wiki.id, String(formData.get("email") ?? ""), String(formData.get("role") ?? "viewer") as Role);
  revalidatePath(`/wikis/${wikiSlug}/settings`);
  redirect(settingsPath(wikiSlug));
}

export async function updateMemberRoleAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await updateMemberRole(wiki.id, String(formData.get("userId")), String(formData.get("role") ?? "viewer") as Role);
  revalidatePath(`/wikis/${wikiSlug}/settings`);
  redirect(settingsPath(wikiSlug));
}

export async function removeMemberAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await removeMember(wiki.id, String(formData.get("userId")));
  revalidatePath(`/wikis/${wikiSlug}/settings`);
  redirect(settingsPath(wikiSlug));
}

export async function createShareLinkAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await createShareLink(wiki.id, "viewer");
  revalidatePath(`/wikis/${wikiSlug}/settings`);
  redirect(settingsPath(wikiSlug));
}

export async function revokeShareLinkAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireOwner(userId, wikiSlug);
  await revokeShareLink(wiki.id, String(formData.get("linkId")));
  revalidatePath(`/wikis/${wikiSlug}/settings`);
  redirect(settingsPath(wikiSlug));
}
