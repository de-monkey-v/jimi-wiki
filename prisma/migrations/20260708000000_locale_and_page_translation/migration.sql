-- 1) User.locale — 선호 UI 언어(기기 간 유지용, 쿠키 부재 시 폴백)
ALTER TABLE "User" ADD COLUMN "locale" TEXT;

-- 2) PageTranslation — 온디맨드 기계 번역 캐시. (page, locale)당 1행, 원문 해시로 stale 판정.
CREATE TABLE "PageTranslation" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageTranslation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageTranslation_pageId_locale_key" ON "PageTranslation"("pageId", "locale");

ALTER TABLE "PageTranslation" ADD CONSTRAINT "PageTranslation_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
