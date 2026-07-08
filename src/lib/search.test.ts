import { test } from "node:test";
import assert from "node:assert/strict";
// search.ts는 server-only + @/lib/db 를 임포트하지만 DB는 지연 연결이라 순수 함수 chunkText는
// 연결/쿼리 없이 돈다. server-only 는 test 실행 shim(-r server-only-shim.cjs)이 처리.
import { chunkText, MAX_CHUNK, MIN_CHUNK } from "./search";

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
