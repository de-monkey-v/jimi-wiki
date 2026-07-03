"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { createApiKey, revokeApiKey } from "@/lib/apikey";

export type IssueKeyState = { token?: string; name?: string; error?: string } | null;

/** useActionState용: 토큰을 URL이 아니라 반환값으로 넘겨 클라이언트에서 1회 표시(히스토리/로그 유출 방지). */
export async function issueKeyAction(_prev: IssueKeyState, formData: FormData): Promise<IssueKeyState> {
  const userId = await getCurrentUserId();
  const name = String(formData.get("name") ?? "").trim() || "key";
  const key = await createApiKey(userId, name);
  revalidatePath("/keys");
  return { token: key.token, name: key.name };
}

export async function revokeKeyAction(formData: FormData) {
  const userId = await getCurrentUserId();
  await revokeApiKey(userId, String(formData.get("id")));
  revalidatePath("/keys");
  redirect("/keys");
}
