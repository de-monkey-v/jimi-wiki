-- 유저별 "읽을거리"(read-later) 링크(SavedLink). 개인·임시 트리아지.
-- (Prisma diff가 pgvector HNSW 인덱스를 drift로 오인해 넣는 DROP INDEX는 의도적으로 제외 — restore_searchchunk_hnsw 참조.)

-- CreateTable
CREATE TABLE "SavedLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedLink_userId_wikiId_createdAt_idx" ON "SavedLink"("userId", "wikiId", "createdAt");

-- AddForeignKey
ALTER TABLE "SavedLink" ADD CONSTRAINT "SavedLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedLink" ADD CONSTRAINT "SavedLink_wikiId_fkey" FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;
