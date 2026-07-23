BEGIN;

ALTER TYPE "DocumentType" ADD VALUE 'research';

ALTER TABLE "PageRevisionSource"
  ADD COLUMN "id" TEXT,
  ADD COLUMN "ordinal" INTEGER,
  ADD COLUMN "sourceRevisionRef" TEXT,
  ADD COLUMN "sourceVersion" INTEGER,
  ADD COLUMN "sourceContentHash" TEXT,
  ADD COLUMN "sourceSlug" TEXT,
  ADD COLUMN "purgedAt" TIMESTAMP(3);

UPDATE "PageRevisionSource" prs
SET
  "id" = 'prs_' || md5(prs."pageRevisionId" || ':' || prs."sourceRevisionId"),
  "sourceRevisionRef" = sr.id,
  "sourceVersion" = sr.version,
  "sourceContentHash" = sr."contentHash",
  "sourceSlug" = s.slug
FROM "SourceRevision" sr
JOIN "Source" s ON s.id = sr."sourceId"
WHERE sr.id = prs."sourceRevisionId";

ALTER TABLE "PageRevisionSource" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "PageRevisionSource" DROP CONSTRAINT "PageRevisionSource_pkey";
ALTER TABLE "PageRevisionSource" ADD CONSTRAINT "PageRevisionSource_pkey" PRIMARY KEY ("id");
ALTER TABLE "PageRevisionSource" ALTER COLUMN "sourceRevisionId" DROP NOT NULL;
ALTER TABLE "PageRevisionSource" DROP CONSTRAINT "PageRevisionSource_sourceRevisionId_fkey";
ALTER TABLE "PageRevisionSource"
  ADD CONSTRAINT "PageRevisionSource_sourceRevisionId_fkey"
  FOREIGN KEY ("sourceRevisionId") REFERENCES "SourceRevision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PageRevisionSource_pageRevisionId_sourceRevisionId_key"
  ON "PageRevisionSource"("pageRevisionId", "sourceRevisionId");
CREATE UNIQUE INDEX "PageRevisionSource_pageRevisionId_ordinal_key"
  ON "PageRevisionSource"("pageRevisionId", "ordinal");
CREATE INDEX "PageRevisionSource_sourceRevisionRef_idx"
  ON "PageRevisionSource"("sourceRevisionRef");

ALTER TABLE "KnowledgeDraftSource" ADD COLUMN "ordinal" INTEGER;
CREATE UNIQUE INDEX "KnowledgeDraftSource_draftId_ordinal_key"
  ON "KnowledgeDraftSource"("draftId", "ordinal");

COMMIT;
