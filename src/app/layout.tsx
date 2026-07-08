import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import { LOCALE_COOKIE, type Locale } from "@/i18n/locales";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Common");
  return {
    title: t("appName"),
    description: t("appDescription"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const t = await getTranslations("Common");

  // 스위처가 호출하는 인라인 server action — 쿠키 set 후 Next가 트리를 자동 재렌더한다.
  async function changeLocaleAction(next: Locale) {
    "use server";
    const store = await cookies();
    store.set(LOCALE_COOKIE, next, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* JS가 차단된 환경(Brave Shields 등) 진단용: 스크립트가 실행되면 이 배너는 보이지 않는다 */}
        <noscript>
          <div style={{ background: "#dc2626", color: "#fff", padding: "10px 16px", fontSize: 14, textAlign: "center" }}>
            ⚠️ {t("noscriptWarning")}
          </div>
        </noscript>
        <NextIntlClientProvider>
          {children}
          <LocaleSwitcher changeLocaleAction={changeLocaleAction} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
