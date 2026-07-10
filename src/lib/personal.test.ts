import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_EXCLUDED_KINDS, isAiExcludedKind, MANUAL_KINDS, PAGE_KINDS, KIND_LABEL, KIND_COLOR } from "./kinds";

test("personal은 AI 제외 kind다", () => {
  assert.ok(AI_EXCLUDED_KINDS.includes("personal"));
  assert.equal(isAiExcludedKind("personal"), true);
});

test("concept/entity/note/meta는 AI 제외가 아니다", () => {
  for (const k of ["note", "concept", "entity", "meta"] as const) {
    assert.equal(isAiExcludedKind(k), false, `${k}는 AI 제외가 아니어야 함`);
  }
});

test("personal은 수동 생성 가능(MANUAL_KINDS)하고 유효 kind(PAGE_KINDS)다", () => {
  assert.ok(MANUAL_KINDS.includes("personal"), "사람이 UI로 만들 수 있어야 함");
  assert.ok(PAGE_KINDS.includes("personal"));
});

test("exhaustive kind 레코드에 personal 등록됨(라벨/색)", () => {
  assert.ok(KIND_LABEL.personal);
  assert.ok(KIND_COLOR.personal);
});
