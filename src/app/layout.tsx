import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "jimi-wiki",
  description: "LLM이 유지보수하는 위키 플랫폼",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* JS가 차단된 환경(Brave Shields 등) 진단용: 스크립트가 실행되면 이 배너는 보이지 않는다 */}
        <noscript>
          <div style={{ background: "#dc2626", color: "#fff", padding: "10px 16px", fontSize: 14, textAlign: "center" }}>
            ⚠️ JavaScript가 실행되지 않고 있습니다 — 모달·채팅·폴더 펼침이 동작하지 않습니다. Brave Shields(주소창의
            사자 아이콘)에서 이 사이트의 스크립트 차단을 해제하거나, 브라우저의 JavaScript 설정을 확인하세요.
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
