-- category 재사용 코퍼스(refType='category')의 (wikiId, refId) 중복 행 방지.
-- 부분 유니크 인덱스라 page/source 청크에는 영향 없음.
CREATE UNIQUE INDEX "SearchChunk_wikiId_refId_category_uq"
  ON "SearchChunk" ("wikiId", "refId")
  WHERE "refType" = 'category';
