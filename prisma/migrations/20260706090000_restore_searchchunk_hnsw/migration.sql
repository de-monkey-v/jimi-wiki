-- Restore pgvector HNSW index for semantic search. A previous migration dropped it
-- while adding API keys, leaving vector search functional but unindexed.
CREATE INDEX IF NOT EXISTS "SearchChunk_embedding_hnsw_idx"
  ON "SearchChunk" USING hnsw ("embedding" vector_cosine_ops);
