"use server";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getPage, deletePage } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { mergeCategory, renameCategory, retireCategory, setPageCategory } from "@/lib/governance";

// lint 페이지 category 거버넌스 액션. editor 이상만.
async function gate(slug: string) {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki || !hasRole(wiki.role, "editor")) throw new Error("권한 없음(editor 이상 필요)");
  return wiki;
}

// 정크 노트(출처 없는 note) 삭제. 1a DELETE 가드와 동일한 안전 재검증을 서버측에서 한 번 더.
export async function deleteJunkNoteAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const pageSlug = String(formData.get("pageSlug") ?? "");
  const page = await getPage(wiki.id, pageSlug);
  if (page && page.kind === "note" && page.sourceId == null) {
    await deletePage(wiki.id, page.slug);
  }
  revalidatePath(`/wikis/${slug}/lint`);
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
