-- 유저·위키·category별 폴더 정렬 override. Auto는 행 부재로 표현해 backfill하지 않는다.

-- CreateEnum
CREATE TYPE "FolderSortMode" AS ENUM ('newest', 'oldest', 'title');

-- CreateTable
CREATE TABLE "FolderSortPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "mode" "FolderSortMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FolderSortPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FolderSortPreference_userId_wikiId_category_key"
ON "FolderSortPreference"("userId", "wikiId", "category");

-- CreateIndex
CREATE INDEX "FolderSortPreference_wikiId_category_idx"
ON "FolderSortPreference"("wikiId", "category");

-- CreateIndex
CREATE INDEX "FolderSortPreference_userId_wikiId_idx"
ON "FolderSortPreference"("userId", "wikiId");

-- AddForeignKey
ALTER TABLE "FolderSortPreference" ADD CONSTRAINT "FolderSortPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderSortPreference" ADD CONSTRAINT "FolderSortPreference_wikiId_fkey"
FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;
