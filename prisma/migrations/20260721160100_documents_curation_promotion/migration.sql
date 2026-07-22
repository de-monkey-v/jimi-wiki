CREATE TYPE "DocumentType" AS ENUM (
  'general',
  'worklog',
  'troubleshooting',
  'decision',
  'reference',
  'plan',
  'spec'
);

CREATE TYPE "SourceCurationState" AS ENUM ('preserved', 'curated');

ALTER TABLE "Page"
  ADD COLUMN "documentType" "DocumentType",
  ADD COLUMN "documentAt" TIMESTAMP(3);

ALTER TABLE "PageRevision"
  ADD COLUMN "documentType" "DocumentType",
  ADD COLUMN "documentAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeDraft"
  ADD COLUMN "documentType" "DocumentType",
  ADD COLUMN "documentAt" TIMESTAMP(3);

ALTER TABLE "Source"
  ADD COLUMN "curationState" "SourceCurationState" NOT NULL DEFAULT 'curated';

ALTER TABLE "SavedLink"
  ADD COLUMN "promotedRunId" TEXT;

CREATE INDEX "Page_wikiId_kind_documentType_documentAt_idx"
  ON "Page"("wikiId", "kind", "documentType", "documentAt");

CREATE INDEX "Source_wikiId_curationState_archivedAt_idx"
  ON "Source"("wikiId", "curationState", "archivedAt");

CREATE UNIQUE INDEX "SavedLink_promotedRunId_key"
  ON "SavedLink"("promotedRunId");

ALTER TABLE "SavedLink"
  ADD CONSTRAINT "SavedLink_promotedRunId_fkey"
  FOREIGN KEY ("promotedRunId") REFERENCES "AgentRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Page"
  ADD CONSTRAINT "Page_document_metadata_check"
  CHECK (
    (
      "kind" = 'document'
      AND "documentType" IS NOT NULL
      AND "documentAt" IS NOT NULL
      AND "sourceId" IS NULL
    )
    OR
    (
      "kind" <> 'document'
      AND "documentType" IS NULL
      AND "documentAt" IS NULL
    )
  );

ALTER TABLE "PageRevision"
  ADD CONSTRAINT "PageRevision_document_metadata_check"
  CHECK (
    (
      "kind" = 'document'
      AND "documentType" IS NOT NULL
      AND "documentAt" IS NOT NULL
      AND "sourceId" IS NULL
    )
    OR
    (
      "kind" <> 'document'
      AND "documentType" IS NULL
      AND "documentAt" IS NULL
    )
  );

ALTER TABLE "KnowledgeDraft"
  ADD CONSTRAINT "KnowledgeDraft_document_metadata_check"
  CHECK (
    (
      "kind" = 'document'
      AND "documentType" IS NOT NULL
      AND "documentAt" IS NOT NULL
    )
    OR
    (
      "kind" <> 'document'
      AND "documentType" IS NULL
      AND "documentAt" IS NULL
    )
  );
