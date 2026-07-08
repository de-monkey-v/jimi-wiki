import { test } from "node:test";
import assert from "node:assert/strict";
import { getBlobStore, makeStorageKey } from "./blob";

test("makeStorageKey: <wikiId>/<yyyy>/<mm>/<uuid>.<ext> 형식 + 확장자 정규화", () => {
  const key = makeStorageKey("wiki123", "PDF");
  assert.match(key, /^wiki123\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
  // 확장자 없는 경우도 안전
  assert.match(makeStorageKey("w", ""), /^w\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
  // 위험 문자는 제거
  assert.match(makeStorageKey("w", "../x"), /\.x$/);
});

test("blob: 경로 이탈(traversal) 키는 거부", async () => {
  const store = getBlobStore();
  await assert.rejects(() => store.get("../../etc/passwd"), /경로 이탈/);
  await assert.rejects(() => store.delete("../secret"), /경로 이탈/);
});
