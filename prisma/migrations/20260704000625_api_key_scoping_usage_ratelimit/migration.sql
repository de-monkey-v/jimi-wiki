-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "maxRole" "Role",
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "wikiId" TEXT;

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "apiKeyId" TEXT,
    "wikiId" TEXT,
    "kind" TEXT NOT NULL,
    "route" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_userId_createdAt_idx" ON "UsageEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_wikiId_createdAt_idx" ON "UsageEvent"("wikiId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiKey_wikiId_idx" ON "ApiKey"("wikiId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_wikiId_fkey" FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;
