import { test } from "node:test";
import assert from "node:assert/strict";
// translate.ts는 server-only + db/gemini 임포트(지연). 순수 함수 pageContentHash만 검증(연결 없음).
import { pageContentHash } from "./translate";

test("pageContentHash: 결정적이고 32자 hex", () => {
  const h = pageContentHash("제목", "본문");
  assert.equal(h, pageContentHash("제목", "본문"));
  assert.match(h, /^[0-9a-f]{32}$/);
});

test("pageContentHash: title 또는 body가 바뀌면 해시도 바뀜(원문 변경 → 재번역)", () => {
  const base = pageContentHash("t", "b");
  assert.notEqual(base, pageContentHash("t2", "b"));
  assert.notEqual(base, pageContentHash("t", "b2"));
});

test("pageContentHash: title/body 경계 모호성 없음(null 구분)", () => {
  // 공백 구분이면 "a"+"b c" 와 "a b"+"c" 가 같은 해시가 되어 캐시 오판 — null 구분으로 방지.
  assert.notEqual(pageContentHash("a", "b c"), pageContentHash("a b", "c"));
});
