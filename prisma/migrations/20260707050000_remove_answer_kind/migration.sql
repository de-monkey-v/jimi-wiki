-- PageKind 에서 'answer' 제거.
-- 답변 페이지는 채팅으로 언제든 재생성 가능한 휘발성 Q&A 였고, 검색 코퍼스를
-- 원문(note)+개념(concept)+개체(entity)로만 유지하기 위해 kind 자체를 제거한다.

-- 1) 기존 answer 페이지의 검색 청크 먼저 제거(SearchChunk.refId 는 FK 아님 → 수동 정리).
DELETE FROM "SearchChunk"
WHERE "refType" = 'page'
  AND "refId" IN (SELECT "id" FROM "Page" WHERE "kind" = 'answer');

-- 2) answer 페이지 삭제(PageLink.toPageId=SetNull, fromPageId/PageContribution=Cascade 는 FK가 처리).
DELETE FROM "Page" WHERE "kind" = 'answer';

-- 3) 'answer' 없는 새 enum 으로 교체(Postgres 는 enum 값 직접 DROP 불가 → 타입 재생성).
ALTER TABLE "Page" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TYPE "PageKind" RENAME TO "PageKind_old";
CREATE TYPE "PageKind" AS ENUM ('note', 'concept', 'entity', 'meta');
ALTER TABLE "Page" ALTER COLUMN "kind" TYPE "PageKind" USING ("kind"::text::"PageKind");
ALTER TABLE "Page" ALTER COLUMN "kind" SET DEFAULT 'note';
DROP TYPE "PageKind_old";
