"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { setModelConfig } from "@/lib/model-config";
import { logout } from "@/lib/openai-oauth";
import { invalidateCatalog } from "@/lib/model-catalog";
import { providerOf, isChatModel } from "@/lib/provider";

// 빈 문자열 = env 폴백(null 저장).
function val(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v || null;
}

/** 모델 선택(chat/gen/ingest) 저장. UI 필터에 의존하지 않고 서버에서 provider 를 검증한다. */
export async function updateModelsAction(fd: FormData) {
  await requireAdmin();
  const chat = val(fd, "chatModel");
  const gen = val(fd, "genModel");
  const ingest = val(fd, "ingestModel");
  // 검증: 채팅은 Gemini·GPT 만(스트리밍 지원), gen·ingest 는 알 수 있는 provider 만.
  if (chat && !isChatModel(chat)) throw new Error(`채팅 모델로 쓸 수 없습니다: ${chat} — Gemini·GPT만 지원(Claude는 ingest·query·lint에서)`);
  if (gen && !providerOf(gen)) throw new Error(`알 수 없는 모델 provider: ${gen} (일반 생성)`);
  if (ingest && !providerOf(ingest)) throw new Error(`알 수 없는 모델 provider: ${ingest} (ingest)`);
  await setModelConfig({ chatModel: chat, genModel: gen, ingestModel: ingest });
  revalidatePath("/admin/settings");
}

/** ChatGPT OAuth 경로 활성/비활성 토글. */
export async function setOAuthEnabledAction(fd: FormData) {
  await requireAdmin();
  await setModelConfig({ openaiOAuth: fd.get("enabled") === "true" });
  revalidatePath("/admin/settings");
}

/** ChatGPT OAuth 로그아웃(토큰 삭제). */
export async function logoutOAuthAction() {
  await requireAdmin();
  logout();
  revalidatePath("/admin/settings");
}

/** models.dev 카탈로그 캐시 무효화(수동 새로고침). */
export async function refreshCatalogAction() {
  await requireAdmin();
  invalidateCatalog();
  revalidatePath("/admin/settings");
}
