import { test } from "node:test";
import assert from "node:assert/strict";
// search.ts는 server-only + @/lib/db 를 임포트하지만 DB는 지연 연결이라 순수 함수 chunkText는
// 연결/쿼리 없이 돈다. server-only 는 test 실행 shim(-r server-only-shim.cjs)이 처리.
import {
  chunkText,
  MAX_CHUNK,
  MIN_CHUNK,
  plannedDepth,
  isRelationalQuery,
  requestedGraphDepth,
  type KgConfig,
} from "./search";

test("chunkText: 단일 짧은 본문 → 라벨 컨텍스트가 붙은 청크 1개", () => {
  const chunks = chunkText("문서", "안녕하세요");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "[문서]\n안녕하세요");
  assert.ok(chunks[0].hash.length > 0);
});

test("chunkText: frontmatter 제거", () => {
  const chunks = chunkText("문서", "---\ntitle: 비밀\n---\n본문만 남는다");
  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].text.includes("title:"), "frontmatter가 남으면 안 됨");
  assert.ok(chunks[0].text.includes("본문만 남는다"));
});

test("chunkText: 짧은 인접 섹션은 이전 청크로 병합(heading 삽입)", () => {
  const chunks = chunkText("문서", "# 에이\n첫 문단\n## 비이\n둘째 문단");
  assert.equal(chunks.length, 1, "둘 다 MIN_CHUNK 미만이라 하나로 병합");
  assert.ok(chunks[0].text.includes("첫 문단"));
  assert.ok(chunks[0].text.includes("둘째 문단"));
  assert.ok(chunks[0].text.includes("## 비이"), "병합 시 하위 heading이 본문에 삽입됨");
});

test("chunkText: MIN_CHUNK 이상 섹션 둘은 병합하지 않고 heading 컨텍스트 유지", () => {
  const big = "가".repeat(MIN_CHUNK + 50);
  const chunks = chunkText("문서", `# 첫섹션\n${big}\n# 둘섹션\n${big}`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].text.startsWith("[문서 > 첫섹션]\n"));
  assert.ok(chunks[1].text.startsWith("[문서 > 둘섹션]\n"));
});

test("chunkText: MAX_CHUNK 초과 섹션은 문단 경계로 분할", () => {
  const para = "가".repeat(Math.ceil(MAX_CHUNK * 0.7)); // 두 문단 합이 MAX_CHUNK 초과
  const chunks = chunkText("문서", `${para}\n\n${para}`);
  assert.ok(chunks.length >= 2, "MAX_CHUNK를 넘으면 문단 단위로 쪼개져야 함");
  for (const c of chunks) {
    // 컨텍스트 프리픽스를 제외한 실제 본문이 MAX_CHUNK 이하
    assert.ok(c.text.length <= MAX_CHUNK + `[문서]\n`.length + 10);
  }
});

// ---------- KG 확장: 순수 정책 함수 ----------
const CFG: KgConfig = { maxHop: 2, simCutoff: 0.55, hubCap: 25, nodeBudget: 12 };

test("plannedDepth: seed 없으면 0", () => {
  assert.equal(plannedDepth({ seedCount: 0, topSimilarity: 0.1, isRelational: true }, CFG), 0);
});

test("plannedDepth: 강한 직접매치 + 비관계 질의 → 0 (no-op, 오늘과 동일)", () => {
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: 0.9, isRelational: false }, CFG), 0);
});

test("plannedDepth: 약한 유사도만 → 1", () => {
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: 0.4, isRelational: false }, CFG), 1);
});

test("plannedDepth: 관계형 질의만(유사도 강함) → 1", () => {
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: 0.9, isRelational: true }, CFG), 1);
});

test("plannedDepth: 약함 AND 관계형 → 2 (maxHop clamp)", () => {
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: 0.4, isRelational: true }, CFG), 2);
});

test("plannedDepth: undefined 유사도(FTS-only)는 weak로 치지 않음 — 비관계면 0", () => {
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: undefined, isRelational: false }, CFG), 0);
  // 관계형이면 undefined 여도 isRelational 만으로 1
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: undefined, isRelational: true }, CFG), 1);
});

test("plannedDepth: maxHop=1 clamp", () => {
  assert.equal(plannedDepth({ seedCount: 1, topSimilarity: 0.4, isRelational: true }, { ...CFG, maxHop: 1 }), 1);
});

test("plannedDepth: maxHop=0 → 항상 0 (킬스위치)", () => {
  assert.equal(plannedDepth({ seedCount: 5, topSimilarity: 0.1, isRelational: true }, { ...CFG, maxHop: 0 }), 0);
});

test("isRelationalQuery: 관계·비교·인과 cue → true", () => {
  for (const q of ["A와 B의 관계는?", "트랜스포머와 RNN 비교", "이것의 원인은?", "X가 Y에 미치는 영향", "compare A and B", "difference between X and Y", "how are they related to each other"]) {
    assert.equal(isRelationalQuery(q), true, `관계 질의여야 함: ${q}`);
  }
});

test("isRelationalQuery: 단순 사실 조회 → false (왜/어떻게는 cue 아님)", () => {
  for (const q of ["트랜스포머란 무엇인가", "LayerNorm 정의", "이 API 사용법", "왜 하늘은 파란가", "how do I install it"]) {
    assert.equal(isRelationalQuery(q), false, `사실 조회여야 함: ${q}`);
  }
});

test("isRelationalQuery: ASCII cue의 부분문자열 오탐 방지(단어경계)", () => {
  // 'cause'∈because, 'depend'∈independent, 'vs'∈TVs, 'differ'∈(없음) 등에 오발동하면 안 됨
  for (const q of ["it failed because of memory", "what is an independent variable", "I bought two TVs", "the universe is vast"]) {
    assert.equal(isRelationalQuery(q), false, `오탐이면 안 됨: ${q}`);
  }
  // 진짜 단어 경계에서는 여전히 true
  for (const q of ["A vs B", "does X depend on Y", "what causes Z"]) {
    assert.equal(isRelationalQuery(q), true, `관계 질의여야 함: ${q}`);
  }
});

// ---------- requestedGraphDepth (외부 REST/MCP 검색의 graph 파라미터) ----------

test("requestedGraphDepth: graph 미지정/거짓값 → 0 (기존 검색과 동일, 하위호환)", () => {
  for (const graph of [undefined, null, "", "0", "false", "no", "아무거나"]) {
    assert.equal(requestedGraphDepth({ graph, depth: "3" }, CFG), 0, `확장하면 안 됨: ${graph}`);
  }
});

test("requestedGraphDepth: graph 참값 + depth 생략 → 1홉", () => {
  for (const graph of ["1", "true", "TRUE", "yes"]) {
    assert.equal(requestedGraphDepth({ graph }, CFG), 1, `1홉이어야 함: ${graph}`);
  }
});

test("requestedGraphDepth: depth는 maxHop으로 clamp, 하한은 1", () => {
  assert.equal(requestedGraphDepth({ graph: "1", depth: "2" }, CFG), 2); // CFG.maxHop=2
  assert.equal(requestedGraphDepth({ graph: "1", depth: "9" }, CFG), 2); // 상한 clamp
  assert.equal(requestedGraphDepth({ graph: "1", depth: "0" }, CFG), 1); // 하한 clamp
  assert.equal(requestedGraphDepth({ graph: "1", depth: "-5" }, CFG), 1);
  assert.equal(requestedGraphDepth({ graph: "1", depth: "abc" }, CFG), 1); // 파싱 실패 → 기본 1
});

test("requestedGraphDepth: maxHop=0 킬스위치면 graph를 요청해도 0", () => {
  assert.equal(requestedGraphDepth({ graph: "1", depth: "3" }, { ...CFG, maxHop: 0 }), 0);
});
