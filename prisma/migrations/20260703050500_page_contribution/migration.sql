-- CreateTable
CREATE TABLE "PageContribution" (
    "id" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,

    CONSTRAINT "PageContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageContribution_sourceId_idx" ON "PageContribution"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "PageContribution_pageId_sourceId_key" ON "PageContribution"("pageId", "sourceId");

-- AddForeignKey
ALTER TABLE "PageContribution" ADD CONSTRAINT "PageContribution_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageContribution" ADD CONSTRAINT "PageContribution_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
