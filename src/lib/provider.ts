/**
 * 모델 id → provider 단일 판별 지점. prefix 추측을 4곳에 흩뿌리지 않고 여기 모은다.
 * 알 수 없는 id 는 null 을 돌려주어(임의로 gemini 로 폴백하지 않음) 상위에서 명시적으로 거부하게 한다.
 */
export type Provider = "google" | "openai" | "anthropic";

// OpenAI 는 연결 방식이 3가지 — 관리자가 명시적으로 하나를 고른다.
export type OpenAITransport = "apikey" | "oauth" | "proxy";

export function providerOf(model: string): Provider | null {
  if (!model) return null;
  if (model.startsWith("claude")) return "anthropic";
  if (/^(gpt|o\d)/i.test(model)) return "openai";
  if (model.startsWith("gemini")) return "google";
  return null;
}

// 채팅(스트리밍) 경로가 지원하는 provider. @ai-sdk/anthropic 미도입이라 claude 는 스트리밍 채팅에서 제외
// (ingest·query·lint 는 claude 사용 가능). 서버·UI 양쪽이 이 목록을 진실의 원천으로 쓴다.
export const CHAT_PROVIDERS: Provider[] = ["google", "openai"];

export function isChatModel(model: string): boolean {
  const p = providerOf(model);
  return p !== null && CHAT_PROVIDERS.includes(p);
}
