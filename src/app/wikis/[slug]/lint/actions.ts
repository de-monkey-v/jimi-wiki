"use server";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { mergeCategory, renameCategory, retireCategory, setPageCategory } from "@/lib/governance";

// lint 페이지 category 거버넌스 액션. editor 이상만.
async function gate(slug: string) {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki || !hasRole(wiki.role, "editor")) throw new Error("권한 없음(editor 이상 필요)");
  return wiki;
}

export async function mergeCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  await mergeCategory(wiki.id, String(formData.get("from") ?? ""), String(formData.get("into") ?? ""));
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function renameCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  await renameCategory(wiki.id, String(formData.get("from") ?? ""), String(formData.get("to") ?? ""));
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function retireCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const reassign = String(formData.get("reassignTo") ?? "").trim();
  await retireCategory(wiki.id, String(formData.get("slug") ?? ""), reassign || null);
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function flattenCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const from = String(formData.get("slug") ?? "");
  const parent = from.split("/").slice(0, -1).join("/"); // 한 단계 상위 경로
  if (!parent) throw new Error("최상위 category는 평탄화할 수 없습니다");
  await renameCategory(wiki.id, from, parent); // 부모가 이미 있으면 renameCategory가 mergeCategory로 위임(흡수)
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function assignCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const category = String(formData.get("category") ?? "").trim();
  await setPageCategory(wiki.id, String(formData.get("pageSlug") ?? ""), category || null);
  revalidatePath(`/wikis/${slug}/lint`);
}
