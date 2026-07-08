"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { setModelConfig, providerUsable } from "@/lib/model-config";
import { logout } from "@/lib/openai-oauth";
import { invalidateCatalog } from "@/lib/model-catalog";
import { providerOf, isChatModel } from "@/lib/provider";

// 빈 문자열 = env 폴백(null 저장).
function val(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v || null;
}

// 선택된 모델이 실제로 쓸 수 있는지(알 수 있는 provider + 자격증명 존재) 검증.
function requireUsable(model: string, label: string) {
  const p = providerOf(model);
  if (!p) throw new Error(`알 수 없는 모델 provider: ${model} (${label})`);
  if (!providerUsable(p)) throw new Error(`자격증명이 없는 provider 입니다: ${model} (${label}) — ${p} 키/OAuth 를 먼저 설정하세요`);
}

/** 모델 선택(chat/gen/ingest) 저장. UI 필터에 의존하지 않고 서버에서 provider·활성 여부를 검증한다. */
export async function updateModelsAction(fd: FormData) {
  await requireAdmin();
  const chat = val(fd, "chatModel");
  const gen = val(fd, "genModel");
  const ingest = val(fd, "ingestModel");
  if (chat) {
    if (!isChatModel(chat)) throw new Error(`채팅 모델로 쓸 수 없습니다: ${chat} — Gemini·GPT만 지원(Claude는 ingest·query·lint에서)`);
    requireUsable(chat, "채팅");
  }
  if (gen) requireUsable(gen, "일반 생성");
  if (ingest) requireUsable(ingest, "ingest");
  await setModelConfig({ chatModel: chat, genModel: gen, ingestModel: ingest });
  revalidatePath("/admin/settings");
}

/** OpenAI 연결 방식 선택(apikey|oauth|proxy). */
export async function setOpenAITransportAction(fd: FormData) {
  await requireAdmin();
  const t = String(fd.get("transport") ?? "");
  if (!["apikey", "oauth", "proxy"].includes(t)) throw new Error("알 수 없는 연결 방식");
  await setModelConfig({ openaiTransport: t });
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
