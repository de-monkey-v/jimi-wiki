"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, deleteSource } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";

// 원문(Source) archive. editor 이상만. 연결 note도 lifecycle archive되고 revision/blob은 보존된다.
export async function deleteSourceAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki || !hasRole(wiki.role, "editor")) throw new Error("권한 없음(editor 이상 필요)");
  const sourceSlug = String(formData.get("sourceSlug") ?? "");
  await deleteSource(wiki.id, sourceSlug, userId);
  revalidatePath(`/wikis/${slug}`);
  redirect(`/wikis/${slug}`); // 원문이 사라졌으니 위키 홈으로
}
