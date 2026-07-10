-- SavedLink에 promotedAt 추가 — 정식 편입 후에도 삭제하지 않고 "편입됨"으로 표시(링크 계속 접근).
-- (Prisma diff가 pgvector HNSW 인덱스를 drift로 오인해 넣는 DROP INDEX는 의도적으로 제외 — restore_searchchunk_hnsw 참조.)

-- AlterTable
ALTER TABLE "SavedLink" ADD COLUMN "promotedAt" TIMESTAMP(3);
