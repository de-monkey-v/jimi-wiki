-- Historical local_auth migration drops this pgvector index unconditionally. An earlier Prisma
-- migration also dropped it, so fresh replay needs it present here. Existing installations may
-- already have the later restored index; IF NOT EXISTS makes this pending backfill harmless.
CREATE INDEX IF NOT EXISTS "SearchChunk_embedding_hnsw_idx"
  ON "SearchChunk" USING hnsw ("embedding" vector_cosine_ops);
