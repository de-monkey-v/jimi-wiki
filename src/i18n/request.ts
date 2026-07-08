import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "./locales";

// 라우팅 없는 쿠키 모드: 로케일을 쿠키에서 읽는다. 쿠키 값은 신뢰 불가 → isLocale로 검증(동적 import 방어).
// 쿠키가 없으면 로그인 유저의 저장된 locale(User.locale)로 폴백 → 기기 간 유지.
export default getRequestConfig(async () => {
  const store = await cookies(); // Next 16: cookies()는 async
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  let locale: Locale | null = isLocale(cookieLocale) ? cookieLocale : null;

  if (!locale) {
    // 세션/DB 접근이 실패해도 request config는 절대 throw하면 안 됨 → 조용히 기본값.
    try {
      const { getCurrentUser } = await import("@/lib/session");
      const user = await getCurrentUser();
      if (isLocale(user?.locale)) locale = user!.locale as Locale;
    } catch {
      /* 미인증·세션 오류 → 기본값 */
    }
  }

  const resolved = locale ?? DEFAULT_LOCALE;
  return {
    locale: resolved,
    messages: (await import(`../../messages/${resolved}.json`)).default,
  };
});
