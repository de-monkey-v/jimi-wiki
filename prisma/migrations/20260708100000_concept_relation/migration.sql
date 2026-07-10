-- 개념 간 타입드 관계(knowledge graph 엣지). 근거(Source)에 접지되며, PageContribution의
-- provenance/cascade 규약을 따른다. (참고: Prisma가 모르는 pgvector HNSW 인덱스를 diff가 drift로
-- 오인해 넣는 `DROP INDEX SearchChunk_embedding_hnsw_idx` 는 의도적으로 제외했다 — restore_searchchunk_hnsw 참조.)

-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('relatedTo', 'partOf', 'causes', 'contrasts', 'dependsOn');

-- CreateTable
CREATE TABLE "ConceptRelation" (
    "id" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "fromPageId" TEXT NOT NULL,
    "toPageId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL DEFAULT 'relatedTo',
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConceptRelation_wikiId_fromPageId_idx" ON "ConceptRelation"("wikiId", "fromPageId");

-- CreateIndex
CREATE INDEX "ConceptRelation_wikiId_toPageId_idx" ON "ConceptRelation"("wikiId", "toPageId");

-- CreateIndex
CREATE INDEX "ConceptRelation_sourceId_idx" ON "ConceptRelation"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptRelation_wikiId_fromPageId_toPageId_type_sourceId_key" ON "ConceptRelation"("wikiId", "fromPageId", "toPageId", "type", "sourceId");

-- AddForeignKey
ALTER TABLE "ConceptRelation" ADD CONSTRAINT "ConceptRelation_wikiId_fkey" FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptRelation" ADD CONSTRAINT "ConceptRelation_fromPageId_fkey" FOREIGN KEY ("fromPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptRelation" ADD CONSTRAINT "ConceptRelation_toPageId_fkey" FOREIGN KEY ("toPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptRelation" ADD CONSTRAINT "ConceptRelation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
