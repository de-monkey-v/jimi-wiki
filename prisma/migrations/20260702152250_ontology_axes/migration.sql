-- AlterEnum
ALTER TYPE "LogKind" ADD VALUE 'ontology';

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "category" TEXT,
ADD COLUMN     "sourceId" TEXT;

-- CreateIndex
CREATE INDEX "Page_wikiId_category_idx" ON "Page"("wikiId", "category");

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
