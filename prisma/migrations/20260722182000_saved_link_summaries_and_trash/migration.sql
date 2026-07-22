-- Recoverable 14-day trash is lifecycle metadata, separate from revisioned archive state.
ALTER TABLE "Wiki"
  ADD COLUMN "trashedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAt" TIMESTAMP(3);

ALTER TABLE "Page"
  ADD COLUMN "trashedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAt" TIMESTAMP(3),
  ADD COLUMN "archivedBeforeTrash" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Source"
  ADD COLUMN "trashedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAt" TIMESTAMP(3),
  ADD COLUMN "archivedBeforeTrash" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SavedLink"
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "trashedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAt" TIMESTAMP(3);

CREATE INDEX "Wiki_trashedAt_idx" ON "Wiki"("trashedAt");
CREATE INDEX "Wiki_purgeAt_idx" ON "Wiki"("purgeAt");
CREATE INDEX "Page_wikiId_trashedAt_idx" ON "Page"("wikiId", "trashedAt");
CREATE INDEX "Page_purgeAt_idx" ON "Page"("purgeAt");
CREATE INDEX "Source_wikiId_trashedAt_idx" ON "Source"("wikiId", "trashedAt");
CREATE INDEX "Source_purgeAt_idx" ON "Source"("purgeAt");
CREATE INDEX "SavedLink_userId_wikiId_trashedAt_idx" ON "SavedLink"("userId", "wikiId", "trashedAt");
CREATE INDEX "SavedLink_purgeAt_idx" ON "SavedLink"("purgeAt");
