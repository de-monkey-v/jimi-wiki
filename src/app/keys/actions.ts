"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { createApiKey, revokeApiKey } from "@/lib/apikey";
import { listWikisForUser } from "@/lib/wiki";
import type { Role } from "@/generated/prisma/client";

export type IssueKeyState = { token?: string; name?: string; error?: string } | null;

/** useActionState용: 토큰을 URL이 아니라 반환값으로 넘겨 클라이언트에서 1회 표시(히스토리/로그 유출 방지). */
export async function issueKeyAction(_prev: IssueKeyState, formData: FormData): Promise<IssueKeyState> {
  const t = await getTranslations("KeysActions");
  const userId = await getCurrentUserId();
  const name = String(formData.get("name") ?? "").trim() || "key";

  // 스코프 위키: 빈 값=전체(레거시). 내가 멤버인 위키만 허용(위·변조 방지 — 넓은 스코프로 falling back 금지).
  const wikiIdRaw = String(formData.get("wikiId") ?? "").trim();
  let wikiId: string | null = null;
  if (wikiIdRaw) {
    const wikis = await listWikisForUser(userId);
    if (!wikis.some((w) => w.id === wikiIdRaw)) return { error: t("invalidWikiSelection") };
    wikiId = wikiIdRaw;
  }

  // 상한 역할: viewer(read-only) 또는 editor만. 그 외/빈 값=다운그레이드 없음(멤버십 역할 그대로).
  const roleRaw = String(formData.get("maxRole") ?? "").trim();
  const maxRole: Role | null = roleRaw === "viewer" || roleRaw === "editor" ? roleRaw : null;

  // 만료: 허용된 일수만(30/90/365). 그 외/빈 값=무만료.
  const daysRaw = String(formData.get("expiresDays") ?? "").trim();
  const ALLOWED_DAYS = new Set([30, 90, 365]);
  const days = Number(daysRaw);
  const expiresAt = ALLOWED_DAYS.has(days) ? new Date(Date.now() + days * 86_400_000) : null;

  let key: { token: string; name: string };
  try {
    key = await createApiKey(userId, name, { wikiId, maxRole, expiresAt });
  } catch (e) {
    return { error: (e as Error).message }; // 활성 키 상한 초과 등
  }
  revalidatePath("/keys");
  return { token: key.token, name: key.name };
}

export async function revokeKeyAction(formData: FormData) {
  const userId = await getCurrentUserId();
  await revokeApiKey(userId, String(formData.get("id")));
  revalidatePath("/keys");
  redirect("/keys");
}
