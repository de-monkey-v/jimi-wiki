-- 유저별 페이지 고정(PagePin). 위키 공유가 아니라 유저 스코프.
-- (Prisma diff가 pgvector HNSW 인덱스를 drift로 오인해 넣는 DROP INDEX는 의도적으로 제외 — restore_searchchunk_hnsw 참조.)

-- CreateTable
CREATE TABLE "PagePin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PagePin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PagePin_userId_wikiId_idx" ON "PagePin"("userId", "wikiId");

-- CreateIndex
CREATE UNIQUE INDEX "PagePin_userId_pageId_key" ON "PagePin"("userId", "pageId");

-- AddForeignKey
ALTER TABLE "PagePin" ADD CONSTRAINT "PagePin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagePin" ADD CONSTRAINT "PagePin_wikiId_fkey" FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagePin" ADD CONSTRAINT "PagePin_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
