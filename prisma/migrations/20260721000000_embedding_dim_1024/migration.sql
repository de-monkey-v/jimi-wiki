-- 임베딩 차원 768 → 1024.
--
-- 왜: 임베딩 프로바이더를 self-host(bge-m3, dense 1024 고정)와 gemini 사이에서 바꿔 쓸 수 있게 한다.
--     gemini-embedding-001 은 MRL 로 128~3072 임의 차원을 낼 수 있어 1024 도 지원하므로,
--     컬럼을 1024 로 통일해두면 이후 프로바이더 교체는 env 변경 + 재색인만으로 끝난다.
--
-- ⚠️ 기존 768 차원 벡터는 1024 로 변환할 수 없다. 이 마이그레이션은 embedding 을 NULL 로 비우며,
--    시맨틱 검색은 재색인 전까지 FTS(BM25)만으로 동작한다(기능 정지 아님, 품질만 저하).
--    적용 후 반드시 전체 재색인을 돌릴 것: 관리자 UI 의 재색인 또는 reindexEmbeddings.
--
-- 벡터 컬럼 타입 변경은 인덱스가 걸린 채로는 못 하므로 HNSW 를 내렸다가 다시 만든다.

DROP INDEX IF EXISTS "SearchChunk_embedding_hnsw_idx";

-- 차원이 다른 기존 벡터 제거(변환 불가). CHECK(internalOnly ⇒ embedding IS NULL)는 계속 만족한다.
UPDATE "SearchChunk" SET embedding = NULL WHERE embedding IS NOT NULL;

ALTER TABLE "SearchChunk" ALTER COLUMN "embedding" TYPE vector(1024);

CREATE INDEX "SearchChunk_embedding_hnsw_idx"
  ON "SearchChunk" USING hnsw ("embedding" vector_cosine_ops);
