import { test } from "node:test";
import assert from "node:assert/strict";
// api-gate 는 server-only + prisma 를 임포트하지만 hasBearerAuth 는 순수 함수라 DB 연결 없이 돈다.
// (server-only 는 test 실행 shim(-r server-only-shim.cjs)이 처리.)
import { hasBearerAuth } from "./api-gate";
import { parseBearer } from "./apikey-core";

const req = (auth?: string) => new Request("http://x/", auth ? { headers: { authorization: auth } } : undefined);

test("hasBearerAuth: Bearer 토큰이 있으면 true, 없으면 false", () => {
  assert.equal(hasBearerAuth(req("Bearer jw_abc")), true);
  assert.equal(hasBearerAuth(req("bearer jw_abc")), true);
  assert.equal(hasBearerAuth(req()), false);
  assert.equal(hasBearerAuth(req("")), false);
});

test("hasBearerAuth: 스킴만 있거나 다른 스킴이면 false(세션 경로로 간다)", () => {
  for (const h of ["Bearer", "Bearer ", "Basic abc", "jw_abc"]) {
    assert.equal(hasBearerAuth(req(h)), false, `false 여야 함: ${JSON.stringify(h)}`);
  }
});

// 판정이 갈리면 유효 키인데 세션 경로로 빠져 401 이 된다 — 두 함수는 항상 같은 결론이어야 한다.
test("hasBearerAuth 는 parseBearer 와 정확히 같은 헤더 집합을 인정한다", () => {
  const headers = [
    "Bearer jw_abc",
    "bearer jw_abc",
    "BEARER jw_abc",
    "  Bearer jw_abc  ", // 선행·후행 공백
    "Bearer\tjw_abc", // 탭 구분
    "Bearer  jw_abc", // 공백 2개
    "Bearer",
    "Bearer ",
    "Bearer a b", // 토큰이 둘
    "Basic jw_abc",
    "jw_abc",
    "",
  ];
  for (const h of headers) {
    assert.equal(
      hasBearerAuth(req(h)),
      parseBearer(h) !== null,
      `판정 불일치: ${JSON.stringify(h)}`,
    );
  }
});
