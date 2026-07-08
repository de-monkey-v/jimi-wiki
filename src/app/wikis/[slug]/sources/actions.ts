"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, deleteSource } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";

// 원문(Source) 삭제. editor 이상만. 연결된 소스 노트도 함께 삭제되고, 정리된 지식은 보존된다.
export async function deleteSourceAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki || !hasRole(wiki.role, "editor")) throw new Error("권한 없음(editor 이상 필요)");
  const sourceSlug = String(formData.get("sourceSlug") ?? "");
  await deleteSource(wiki.id, sourceSlug);
  revalidatePath(`/wikis/${slug}`);
  redirect(`/wikis/${slug}`); // 원문이 사라졌으니 위키 홈으로
}
