-- 유저별 폴더(category) 고정(FolderPin). 자주 여는 폴더 빠른 접근.
-- (Prisma diff가 pgvector HNSW 인덱스를 drift로 오인해 넣는 DROP INDEX는 의도적으로 제외 — restore_searchchunk_hnsw 참조.)

-- CreateTable
CREATE TABLE "FolderPin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FolderPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FolderPin_userId_wikiId_idx" ON "FolderPin"("userId", "wikiId");

-- CreateIndex
CREATE UNIQUE INDEX "FolderPin_userId_wikiId_category_key" ON "FolderPin"("userId", "wikiId", "category");

-- AddForeignKey
ALTER TABLE "FolderPin" ADD CONSTRAINT "FolderPin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderPin" ADD CONSTRAINT "FolderPin_wikiId_fkey" FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;
