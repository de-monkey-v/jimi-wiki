import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// 인자 없이 호출하면 src/i18n/request.ts 를 자동 탐지한다.
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // Prisma(및 런타임 유틸)를 서버 번들에서 external 처리 — node_modules에서 직접 로드
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "@prisma/client-runtime-utils",
    // ingest 본문 추출/자막(ESM + linkedom/sanitize-html) — 서버 번들에 넣지 않고 node_modules에서 로드
    "@extractus/article-extractor",
    "youtube-caption-extractor",
    // 파일 파서(워커에서 dynamic import) — 서버 번들에 넣지 않고 node_modules에서 로드
    "unpdf",
    "mammoth",
    "officeparser",
    "yauzl",
  ],
  // 파일 업로드는 Server Action multipart 로 들어온다. bodySizeLimit 은 요청 '전체'(다중 파일 합계) 상한이라
  // 기본 1MB 로는 부족 → MAX_REQUEST_BYTES(50MB)와 정합. 파일당 상한(MAX_UPLOAD_BYTES 25MB)은 액션에서 별도 검증.
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
  // dev 서버를 localhost가 아닌 호스트명으로 접속할 때 HMR/정적 리소스가 차단되지 않도록 허용.
  // (oss-wsl = 이 WSL 머신의 호스트명 — Windows 브라우저에서 이 이름으로 접속)
  allowedDevOrigins: ["oss-wsl", "*.oss-wsl", "localhost", "127.0.0.1"],
};

export default withNextIntl(nextConfig);
