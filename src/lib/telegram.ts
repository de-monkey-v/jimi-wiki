// 텔레그램 Bot API 얇은 클라이언트 + 웹훅 페이로드 파싱/인증(순수 로직).
// 새 의존성 없이 전역 fetch 사용. server-only 아님 — 파싱/검증 헬퍼는 스크립트·테스트에서도 import.
import { hashApiKey, safeEqualHex } from "@/lib/apikey-core";
import { botToken, webhookSecret } from "@/lib/telegram-config";

const API_BASE = "https://api.telegram.org";
const MAX_MSG = 4000; // 텔레그램 상한 4096 — 여유를 두고 분할

// ---------- 웹훅 인증 ----------
/** 텔레그램이 매 요청에 싣는 X-Telegram-Bot-Api-Secret-Token 헤더를 설정 시크릿과 상수시간 비교. */
export function verifyWebhookSecret(received: string | null): boolean {
  const expected = webhookSecret();
  if (!expected || !received) return false;
  // 시크릿은 hex가 아니므로 sha256(hex)로 정규화 후 상수시간 비교(길이 노출·타이밍 방지).
  return safeEqualHex(hashApiKey(received), hashApiKey(expected));
}

// ---------- 페이로드 파싱(순수) ----------
export interface TgMessage {
  chatId: string; // chat.id (음수·64비트 가능 → 문자열 보존)
  text: string;
  fromId: string | null; // from.id (봇 채널 메시지 등은 없을 수 있음)
  chatType: string; // "private" | "group" | "supergroup" | "channel"
}

/** 텔레그램 update → 정규화 메시지. 텍스트 메시지가 아니면 null. */
export function parseUpdate(body: unknown): TgMessage | null {
  if (!body || typeof body !== "object") return null;
  const msg = (body as { message?: unknown }).message;
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { text?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown } };
  if (typeof m.text !== "string" || !m.chat || m.chat.id == null) return null;
  return {
    chatId: String(m.chat.id),
    text: m.text,
    fromId: m.from?.id != null ? String(m.from.id) : null,
    chatType: typeof m.chat.type === "string" ? m.chat.type : "unknown",
  };
}

export interface TgCommand {
  cmd: string; // 소문자, 선행 "/" 제거, "@봇이름" 제거
  args: string; // 명령 뒤 나머지 문자열(trim)
}

/** "/bind@MyBot my-wiki" → {cmd:"bind", args:"my-wiki"}. 명령이 아니면 null. */
export function parseCommand(text: string): TgCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const sp = t.indexOf(" ");
  const head = sp === -1 ? t.slice(1) : t.slice(1, sp);
  const args = sp === -1 ? "" : t.slice(sp + 1).trim();
  const cmd = head.split("@")[0].toLowerCase(); // @봇멘션 제거
  if (!cmd) return null;
  return { cmd, args };
}

// ---------- Bot API 호출 ----------
async function tgApi(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN 미설정");
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!json.ok) throw new Error(`텔레그램 ${method} 실패: ${json.description ?? res.status}`);
  return json;
}

/** 긴 텍스트를 4000자 단위로 잘라 순서대로 전송. 인증/네트워크 실패는 throw. */
export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await tgApi("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  }
}

export async function sendChatAction(chatId: string | number, action = "typing"): Promise<void> {
  await tgApi("sendChatAction", { chat_id: chatId, action }).catch(() => {}); // 타이핑 표시는 비치명적
}

/** 웹훅 등록. secret_token 은 이후 매 요청 헤더로 되돌아온다(verifyWebhookSecret 대상). */
export async function setWebhook(url: string, secret: string): Promise<void> {
  await tgApi("setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
}

/** 텔레그램 메시지 길이 상한을 넘지 않게 분할. 가능하면 개행 경계에서 자른다. */
export function splitMessage(text: string, max = MAX_MSG): string[] {
  const t = text.length ? text : "(빈 응답)";
  if (t.length <= max) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // 개행이 너무 앞이면 그냥 max에서 자름
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
