-- Regenerable knowledge layer: append-only snapshots, staging builds, and an
-- explicit external-model policy. Keep the hand-written pgvector indexes; this
-- migration intentionally does not contain Prisma's spurious HNSW DROP.

-- CreateEnum
CREATE TYPE "PageOrigin" AS ENUM ('human', 'generated', 'mixed', 'system');
CREATE TYPE "ModelAccess" AS ENUM ('external', 'internalOnly');
CREATE TYPE "RevisionActor" AS ENUM ('human', 'agent', 'system', 'restore');
CREATE TYPE "BuildMode" AS ENUM ('incremental', 'full', 'restore');
CREATE TYPE "BuildStatus" AS ENUM ('pending', 'running', 'review', 'published', 'publishedDegraded', 'failed', 'cancelled');
CREATE TYPE "DraftStatus" AS ENUM ('staged', 'conflict', 'published', 'accepted', 'rejected', 'stale', 'suppressed');

-- AgentRun remains the generic queue. The worker may dispatch rebuild jobs
-- after this migration commits.
ALTER TYPE "AgentType" ADD VALUE IF NOT EXISTS 'rebuild';

-- Projection policy/version columns. Defaults preserve the public API's
-- historical behaviour; stricter legacy rows are backfilled below.
ALTER TABLE "Page"
  ADD COLUMN "origin" "PageOrigin" NOT NULL DEFAULT 'human',
  ADD COLUMN "modelAccess" "ModelAccess" NOT NULL DEFAULT 'external',
  ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "policyVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "suppressedAt" TIMESTAMP(3),
  ADD COLUMN "staleAt" TIMESTAMP(3);

ALTER TABLE "Source"
  ADD COLUMN "modelAccess" "ModelAccess" NOT NULL DEFAULT 'external',
  ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "policyVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "SearchChunk"
  ADD COLUMN "modelAccess" "ModelAccess" NOT NULL DEFAULT 'external';

ALTER TABLE "UsageEvent"
  ADD COLUMN "buildId" TEXT,
  ADD COLUMN "phase" TEXT;

-- Builds exist before PageRevision because a revision may record the build
-- that created it. User/build actor identifiers other than this FK are soft
-- references so deleting operational logs never deletes history.
CREATE TABLE "KnowledgeBuild" (
  "id" TEXT NOT NULL,
  "wikiId" TEXT NOT NULL,
  "agentRunId" TEXT,
  "createdById" TEXT,
  "mode" "BuildMode" NOT NULL,
  "status" "BuildStatus" NOT NULL DEFAULT 'pending',
  "model" TEXT,
  "promptVersion" TEXT,
  "rulesHash" TEXT,
  "inputManifest" JSONB NOT NULL DEFAULT '{}',
  "publishedManifest" JSONB NOT NULL DEFAULT '{}',
  "relationManifest" JSONB NOT NULL DEFAULT '[]',
  "costUsd" DOUBLE PRECISION,
  "error" JSONB,
  "restorable" BOOLEAN NOT NULL DEFAULT true,
  "unrestorableReason" TEXT,
  "forceExtraction" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),

  CONSTRAINT "KnowledgeBuild_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PageRevision" (
  "id" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "kind" "PageKind" NOT NULL,
  "frontmatter" JSONB NOT NULL DEFAULT '{}',
  "category" TEXT,
  "parentId" TEXT,
  "sortOrder" INTEGER NOT NULL,
  "sourceId" TEXT,
  "origin" "PageOrigin" NOT NULL,
  "modelAccess" "ModelAccess" NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "suppressedAt" TIMESTAMP(3),
  "staleAt" TIMESTAMP(3),
  "contentHash" TEXT NOT NULL,
  "actor" "RevisionActor" NOT NULL,
  "reason" TEXT,
  "userId" TEXT,
  "agentRunId" TEXT,
  "buildId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PageRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SourceRevision" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "body" TEXT,
  "storageKey" TEXT,
  "modelAccess" "ModelAccess" NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "contentHash" TEXT NOT NULL,
  "actor" "RevisionActor" NOT NULL,
  "reason" TEXT,
  "userId" TEXT,
  "agentRunId" TEXT,
  "buildId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SourceRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PageRevisionSource" (
  "pageRevisionId" TEXT NOT NULL,
  "sourceRevisionId" TEXT NOT NULL,

  CONSTRAINT "PageRevisionSource_pkey" PRIMARY KEY ("pageRevisionId", "sourceRevisionId")
);

CREATE TABLE "SourceExtraction" (
  "id" TEXT NOT NULL,
  "sourceRevisionId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "rulesHash" TEXT NOT NULL,
  "claims" JSONB NOT NULL DEFAULT '[]',
  "concepts" JSONB NOT NULL DEFAULT '[]',
  "entities" JSONB NOT NULL DEFAULT '[]',
  "relations" JSONB NOT NULL DEFAULT '[]',
  "sourceNote" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SourceExtraction_pkey" PRIMARY KEY ("id")
);

-- A force-refresh creates another immutable extraction even when the
-- fingerprint is unchanged. This join records the exact extraction selected by
-- each build; cache reuse points at an existing row instead of overwriting it.
CREATE TABLE "KnowledgeBuildExtraction" (
  "id" TEXT NOT NULL,
  "buildId" TEXT NOT NULL,
  "sourceExtractionId" TEXT NOT NULL,
  "sourceRevisionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeBuildExtraction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDraft" (
  "id" TEXT NOT NULL,
  "buildId" TEXT NOT NULL,
  "pageId" TEXT,
  "slug" TEXT NOT NULL,
  "baseVersion" INTEGER,
  "status" "DraftStatus" NOT NULL DEFAULT 'staged',
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "kind" "PageKind" NOT NULL,
  "frontmatter" JSONB NOT NULL DEFAULT '{}',
  "category" TEXT,
  "parentId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "origin" "PageOrigin" NOT NULL DEFAULT 'generated',
  "modelAccess" "ModelAccess" NOT NULL DEFAULT 'external',
  "archivedAt" TIMESTAMP(3),
  "suppressedAt" TIMESTAMP(3),
  "staleAt" TIMESTAMP(3),
  "contentHash" TEXT NOT NULL,
  "validation" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDraftSource" (
  "draftId" TEXT NOT NULL,
  "sourceRevisionId" TEXT NOT NULL,

  CONSTRAINT "KnowledgeDraftSource_pkey" PRIMARY KEY ("draftId", "sourceRevisionId")
);

CREATE TABLE "KnowledgeBuildPageRevision" (
  "id" TEXT NOT NULL,
  "buildId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "pageRevisionId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeBuildPageRevision_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "KnowledgeBuild_wikiId_createdAt_idx" ON "KnowledgeBuild"("wikiId", "createdAt");
CREATE INDEX "KnowledgeBuild_wikiId_status_idx" ON "KnowledgeBuild"("wikiId", "status");
CREATE INDEX "KnowledgeBuild_agentRunId_idx" ON "KnowledgeBuild"("agentRunId");

CREATE UNIQUE INDEX "PageRevision_pageId_version_key" ON "PageRevision"("pageId", "version");
CREATE INDEX "PageRevision_buildId_idx" ON "PageRevision"("buildId");
CREATE INDEX "PageRevision_createdAt_idx" ON "PageRevision"("createdAt");

CREATE UNIQUE INDEX "SourceRevision_sourceId_version_key" ON "SourceRevision"("sourceId", "version");
CREATE INDEX "SourceRevision_buildId_idx" ON "SourceRevision"("buildId");
CREATE INDEX "SourceRevision_createdAt_idx" ON "SourceRevision"("createdAt");

CREATE INDEX "PageRevisionSource_sourceRevisionId_idx" ON "PageRevisionSource"("sourceRevisionId");
CREATE INDEX "SourceExtraction_sourceRevisionId_fingerprint_idx" ON "SourceExtraction"("sourceRevisionId", "fingerprint");
CREATE INDEX "SourceExtraction_createdAt_idx" ON "SourceExtraction"("createdAt");
CREATE UNIQUE INDEX "KnowledgeBuildExtraction_buildId_sourceRevisionId_key" ON "KnowledgeBuildExtraction"("buildId", "sourceRevisionId");
CREATE INDEX "KnowledgeBuildExtraction_sourceExtractionId_idx" ON "KnowledgeBuildExtraction"("sourceExtractionId");
CREATE INDEX "KnowledgeBuildExtraction_sourceRevisionId_idx" ON "KnowledgeBuildExtraction"("sourceRevisionId");

CREATE UNIQUE INDEX "KnowledgeDraft_buildId_slug_key" ON "KnowledgeDraft"("buildId", "slug");
CREATE INDEX "KnowledgeDraft_pageId_idx" ON "KnowledgeDraft"("pageId");
CREATE INDEX "KnowledgeDraft_buildId_status_idx" ON "KnowledgeDraft"("buildId", "status");
CREATE INDEX "KnowledgeDraftSource_sourceRevisionId_idx" ON "KnowledgeDraftSource"("sourceRevisionId");

CREATE UNIQUE INDEX "KnowledgeBuildPageRevision_buildId_pageId_key" ON "KnowledgeBuildPageRevision"("buildId", "pageId");
CREATE UNIQUE INDEX "KnowledgeBuildPageRevision_buildId_pageRevisionId_key" ON "KnowledgeBuildPageRevision"("buildId", "pageRevisionId");
CREATE INDEX "KnowledgeBuildPageRevision_pageRevisionId_idx" ON "KnowledgeBuildPageRevision"("pageRevisionId");

CREATE INDEX "Page_wikiId_archivedAt_idx" ON "Page"("wikiId", "archivedAt");
CREATE INDEX "Page_wikiId_modelAccess_archivedAt_idx" ON "Page"("wikiId", "modelAccess", "archivedAt");
CREATE INDEX "Source_wikiId_archivedAt_idx" ON "Source"("wikiId", "archivedAt");
CREATE INDEX "Source_wikiId_modelAccess_archivedAt_idx" ON "Source"("wikiId", "modelAccess", "archivedAt");
CREATE INDEX "SearchChunk_wikiId_modelAccess_idx" ON "SearchChunk"("wikiId", "modelAccess");
CREATE INDEX "UsageEvent_buildId_createdAt_idx" ON "UsageEvent"("buildId", "createdAt");

-- Foreign keys
ALTER TABLE "KnowledgeBuild" ADD CONSTRAINT "KnowledgeBuild_wikiId_fkey"
  FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBuild" ADD CONSTRAINT "KnowledgeBuild_agentRunId_fkey"
  FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PageRevision" ADD CONSTRAINT "PageRevision_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PageRevision" ADD CONSTRAINT "PageRevision_buildId_fkey"
  FOREIGN KEY ("buildId") REFERENCES "KnowledgeBuild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SourceRevision" ADD CONSTRAINT "SourceRevision_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageRevisionSource" ADD CONSTRAINT "PageRevisionSource_pageRevisionId_fkey"
  FOREIGN KEY ("pageRevisionId") REFERENCES "PageRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PageRevisionSource" ADD CONSTRAINT "PageRevisionSource_sourceRevisionId_fkey"
  FOREIGN KEY ("sourceRevisionId") REFERENCES "SourceRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SourceExtraction" ADD CONSTRAINT "SourceExtraction_sourceRevisionId_fkey"
  FOREIGN KEY ("sourceRevisionId") REFERENCES "SourceRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeBuildExtraction" ADD CONSTRAINT "KnowledgeBuildExtraction_buildId_fkey"
  FOREIGN KEY ("buildId") REFERENCES "KnowledgeBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBuildExtraction" ADD CONSTRAINT "KnowledgeBuildExtraction_sourceExtractionId_fkey"
  FOREIGN KEY ("sourceExtractionId") REFERENCES "SourceExtraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBuildExtraction" ADD CONSTRAINT "KnowledgeBuildExtraction_sourceRevisionId_fkey"
  FOREIGN KEY ("sourceRevisionId") REFERENCES "SourceRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDraft" ADD CONSTRAINT "KnowledgeDraft_buildId_fkey"
  FOREIGN KEY ("buildId") REFERENCES "KnowledgeBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDraft" ADD CONSTRAINT "KnowledgeDraft_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDraftSource" ADD CONSTRAINT "KnowledgeDraftSource_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "KnowledgeDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDraftSource" ADD CONSTRAINT "KnowledgeDraftSource_sourceRevisionId_fkey"
  FOREIGN KEY ("sourceRevisionId") REFERENCES "SourceRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeBuildPageRevision" ADD CONSTRAINT "KnowledgeBuildPageRevision_buildId_fkey"
  FOREIGN KEY ("buildId") REFERENCES "KnowledgeBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBuildPageRevision" ADD CONSTRAINT "KnowledgeBuildPageRevision_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBuildPageRevision" ADD CONSTRAINT "KnowledgeBuildPageRevision_pageRevisionId_fkey"
  FOREIGN KEY ("pageRevisionId") REFERENCES "PageRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail-closed legacy policy backfill.
UPDATE "Page"
SET "modelAccess" = 'internalOnly'
WHERE "kind" = 'personal';

UPDATE "Page"
SET "origin" = 'system'
WHERE "slug" = 'ontology' AND "kind" = 'meta';

-- Legacy personal pages deliberately had no SearchChunk at all. Seed a
-- deterministic local-FTS chunk so they become discoverable immediately; the
-- normal page reindexer may later replace this coarse one-chunk backfill.
INSERT INTO "SearchChunk" (
  "id", "wikiId", "refType", "refId", "heading", "text", "hash", "modelAccess", embedding
)
SELECT
  'backfill-personal-' || p."id",
  p."wikiId",
  'page',
  p."id",
  '',
  '[' || p."slug" || ']' || E'\n' || p."body",
  substr(md5('[' || p."slug" || ']' || E'\n' || p."body"), 1, 16),
  'internalOnly',
  NULL
FROM "Page" AS p
WHERE p."kind" = 'personal'
  AND p."archivedAt" IS NULL
  AND p."slug" <> 'ontology'
  AND btrim(p."body") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "SearchChunk" AS existing
    WHERE existing."wikiId" = p."wikiId"
      AND existing."refType" = 'page'
      AND existing."refId" = p."id"
  );

UPDATE "SearchChunk" AS c
SET "modelAccess" = p."modelAccess"
FROM "Page" AS p
WHERE c."refType" = 'page' AND c."refId" = p."id";

UPDATE "SearchChunk" AS c
SET "modelAccess" = s."modelAccess"
FROM "Source" AS s
WHERE c."refType" = 'source' AND c."refId" = s."id";

UPDATE "SearchChunk"
SET embedding = NULL
WHERE "modelAccess" = 'internalOnly';

-- Every existing projection starts with a durable version-1 snapshot. IDs are
-- deterministic and do not require a database UUID extension.
INSERT INTO "SourceRevision" (
  "id", "sourceId", "version", "title", "url", "body", "storageKey",
  "modelAccess", "archivedAt", "contentHash", "actor", "reason", "createdAt"
)
SELECT
  'backfill-source-' || s."id",
  s."id",
  1,
  s."title",
  s."url",
  s."body",
  s."storageKey",
  s."modelAccess",
  s."archivedAt",
  md5(concat_ws(E'\x1f', s."title", s."url", s."body", s."storageKey", s."modelAccess"::text, s."archivedAt"::text)),
  'system',
  'initial revision backfill',
  s."ingestedAt"
FROM "Source" AS s;

INSERT INTO "PageRevision" (
  "id", "pageId", "version", "title", "body", "kind", "frontmatter",
  "category", "parentId", "sortOrder", "sourceId", "origin", "modelAccess", "archivedAt",
  "suppressedAt", "staleAt", "contentHash", "actor", "reason", "createdAt"
)
SELECT
  'backfill-page-' || p."id",
  p."id",
  1,
  p."title",
  p."body",
  p."kind",
  p."frontmatter",
  p."category",
  p."parentId",
  p."sortOrder",
  p."sourceId",
  p."origin",
  p."modelAccess",
  p."archivedAt",
  p."suppressedAt",
  p."staleAt",
  md5(concat_ws(E'\x1f', p."title", p."body", p."kind"::text, p."frontmatter"::text, p."category", p."parentId", p."sortOrder"::text, p."sourceId", p."origin"::text, p."modelAccess"::text, p."archivedAt"::text, p."suppressedAt"::text, p."staleAt"::text)),
  'system',
  'initial revision backfill',
  p."updatedAt"
FROM "Page" AS p;

-- Preserve both note provenance and derived-page contributions in the initial
-- revision. Duplicate evidence is collapsed by the composite primary key.
INSERT INTO "PageRevisionSource" ("pageRevisionId", "sourceRevisionId")
SELECT DISTINCT 'backfill-page-' || p."id", 'backfill-source-' || p."sourceId"
FROM "Page" AS p
WHERE p."sourceId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Existing graph projection predates SourceRevision. Attach each edge to the
-- immutable current revision present at migration time, then make it required.
ALTER TABLE "ConceptRelation" ADD COLUMN "sourceRevisionId" TEXT;
UPDATE "ConceptRelation" AS cr
SET "sourceRevisionId" = sr."id"
FROM "SourceRevision" AS sr
WHERE sr."sourceId" = cr."sourceId" AND sr."version" = 1;
ALTER TABLE "ConceptRelation" ALTER COLUMN "sourceRevisionId" SET NOT NULL;
DROP INDEX "ConceptRelation_wikiId_fromPageId_toPageId_type_sourceId_key";
CREATE UNIQUE INDEX "ConceptRelation_wikiId_fromPageId_toPageId_type_sourceRevisionId_key"
  ON "ConceptRelation"("wikiId", "fromPageId", "toPageId", "type", "sourceRevisionId");
CREATE INDEX "ConceptRelation_sourceRevisionId_idx" ON "ConceptRelation"("sourceRevisionId");
ALTER TABLE "ConceptRelation" ADD CONSTRAINT "ConceptRelation_sourceRevisionId_fkey"
  FOREIGN KEY ("sourceRevisionId") REFERENCES "SourceRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PageRevisionSource" ("pageRevisionId", "sourceRevisionId")
SELECT DISTINCT 'backfill-page-' || pc."pageId", 'backfill-source-' || pc."sourceId"
FROM "PageContribution" AS pc
ON CONFLICT DO NOTHING;

-- Database-level fail-closed invariants. Application helpers enforce the same
-- rules and provide friendlier errors, while these checks guard scripts/SQL.
ALTER TABLE "Page" ADD CONSTRAINT "Page_personal_internal_only_check"
  CHECK ("kind" <> 'personal' OR "modelAccess" = 'internalOnly');
ALTER TABLE "Page" ADD CONSTRAINT "Page_version_positive_check"
  CHECK ("currentVersion" > 0 AND "policyVersion" > 0);
ALTER TABLE "Source" ADD CONSTRAINT "Source_version_positive_check"
  CHECK ("currentVersion" > 0 AND "policyVersion" > 0);
ALTER TABLE "SearchChunk" ADD CONSTRAINT "SearchChunk_internal_embedding_null_check"
  CHECK ("modelAccess" = 'external' OR embedding IS NULL);
