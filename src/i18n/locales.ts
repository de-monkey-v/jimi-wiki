// 지원 로케일 정의(단일 출처). request.ts·스위처·검증 스크립트가 공유한다.
export const LOCALES = ["ko", "en", "ja", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ko";

// 쿠키 이름 — request.ts가 읽고 스위처가 쓴다(값이 같아야 함).
export const LOCALE_COOKIE = "NEXT_LOCALE";

// 스위처에 표시할 원어 라벨.
export const LOCALE_LABELS: Record<Locale, string> = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
  zh: "中文",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
