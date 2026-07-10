-- PageKind에 'personal'(개인 수동 메모, AI 완전 제외) 추가.
-- Postgres는 ALTER TYPE ... ADD VALUE 를 같은 트랜잭션에서 사용할 수 없어 독립 마이그레이션으로 둔다.
-- (Prisma diff가 pgvector HNSW 인덱스를 drift로 오인해 넣는 DROP INDEX는 여기 없음 — restore_searchchunk_hnsw 참조.)
ALTER TYPE "PageKind" ADD VALUE IF NOT EXISTS 'personal';
