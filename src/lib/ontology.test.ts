import { test } from "node:test";
import assert from "node:assert/strict";
// ontology.ts는 server-only + @/lib/db 임포트(지연 연결). 순수 정화/예약 함수만 검증.
import { sanitizeCategorySlug, sanitizeLabel, isReservedSlug, CATEGORY_MAX_DEPTH } from "./ontology";

test("sanitizeCategorySlug: 소문자·공백→하이픈·경로 유지", () => {
  assert.equal(sanitizeCategorySlug("AI / Architectures"), "ai/architectures");
  assert.equal(sanitizeCategorySlug("한글 카테고리"), "한글-카테고리");
});

test("sanitizeCategorySlug: 연속 구분자 축약·앞뒤 정리", () => {
  assert.equal(sanitizeCategorySlug("  //foo---bar//  "), "foo-bar");
  assert.equal(sanitizeCategorySlug("a // b"), "a/b");
});

test("sanitizeCategorySlug: 프롬프트 인젝션류 문자 제거", () => {
  assert.equal(sanitizeCategorySlug("ignore<script>prev"), "ignorescriptprev");
  assert.equal(sanitizeCategorySlug("!!!"), null); // 전부 제거되면 null
});

test("sanitizeCategorySlug: CATEGORY_MAX_DEPTH 초과 경로는 거부", () => {
  const ok = Array.from({ length: CATEGORY_MAX_DEPTH }, (_, i) => `l${i}`).join("/");
  assert.equal(sanitizeCategorySlug(ok), ok);
  const tooDeep = Array.from({ length: CATEGORY_MAX_DEPTH + 1 }, (_, i) => `l${i}`).join("/");
  assert.equal(sanitizeCategorySlug(tooDeep), null);
});

test("sanitizeLabel: 빈 값은 '무제'로 폴백, 길이 상한", () => {
  assert.equal(sanitizeLabel("   "), "무제");
  assert.equal(sanitizeLabel("정상 라벨 (설명)"), "정상 라벨 (설명)");
  assert.ok(sanitizeLabel("가".repeat(200)).length <= 60);
});

test("isReservedSlug: system·정적 라우트 slug는 예약", () => {
  for (const s of ["ontology", "chat", "lint", "settings", "sources", "graph", "new"]) {
    assert.equal(isReservedSlug(s), true, `${s}는 예약 slug`);
  }
  assert.equal(isReservedSlug("  Graph "), true); // trim+lowercase
  assert.equal(isReservedSlug("my-page"), false);
});
