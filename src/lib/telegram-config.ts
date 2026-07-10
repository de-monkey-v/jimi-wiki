/**
 * 텔레그램 봇 설정 — self-host 설치자가 env로 켜는 단일 소스.
 * telegram.ts · webhook route · worker 알림 훅이 모두 이 함수를 import 한다(중복 정의 금지).
 * auth-mode.ts 와 같은 얇은 헬퍼 패턴(process.env 직접 읽기, DB 오버라이드 없음).
 */
/** 서비스 계정(봇 User) 식별 이메일 — 시드가 이 이메일로 User를 만들고, 런타임이 이 이메일로 조회한다. */
export const BOT_USER_EMAIL = "telegram-bot@jimi.local";

export function botToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
}

export function webhookSecret(): string {
  return (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
}

/** 봇 활성 조건: 토큰 + 웹훅 시크릿이 모두 있어야 한다(시크릿 없으면 웹훅 인증 불가 → 비활성 취급). */
export function isTelegramEnabled(): boolean {
  return botToken().length > 0 && webhookSecret().length > 0;
}
