import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from "./locales";

// 라우팅 없는 쿠키 모드: 로케일을 URL이 아니라 쿠키에서 읽는다.
// 쿠키 값은 신뢰할 수 없으므로 반드시 화이트리스트(isLocale)로 검증 — 동적 import() 방어.
export default getRequestConfig(async () => {
  const store = await cookies(); // Next 16: cookies()는 async
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
