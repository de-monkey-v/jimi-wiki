import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAgentWriteConflict,
  isPolicyRelaxation,
  modelAccessForKind,
  modelAccessForRestore,
  originForCreate,
  stricterModelAccess,
  transitionPageOrigin,
} from "./content-policy";

test("modelAccess strictness는 internalOnly가 항상 우선한다", () => {
  assert.equal(stricterModelAccess("external", "external"), "external");
  assert.equal(stricterModelAccess("external", "internalOnly"), "internalOnly");
  assert.equal(modelAccessForRestore("internalOnly", "external", "concept"), "internalOnly");
  assert.equal(modelAccessForRestore("external", "internalOnly", "concept"), "internalOnly");
});

test("personal은 요청 정책과 무관하게 internalOnly다", () => {
  assert.equal(modelAccessForKind("personal", "external"), "internalOnly");
  assert.equal(modelAccessForRestore("external", "external", "personal"), "internalOnly");
});

test("origin 생성과 사람 편집 전이가 계획의 불변식을 따른다", () => {
  assert.equal(originForCreate("human"), "human");
  assert.equal(originForCreate("agent"), "generated");
  assert.equal(originForCreate("agent", "human"), "generated");
  assert.equal(originForCreate("system"), "system");
  assert.equal(transitionPageOrigin("generated", "human"), "mixed");
  assert.equal(transitionPageOrigin("human", "human"), "human");
  assert.equal(transitionPageOrigin("mixed", "human"), "mixed");
});

test("agent는 human/mixed를 자동 덮어쓸 수 없고 승인 시 mixed가 된다", () => {
  assert.equal(isAgentWriteConflict("human", "agent"), true);
  assert.equal(isAgentWriteConflict("mixed", "agent"), true);
  assert.equal(isAgentWriteConflict("generated", "agent"), false);
  assert.equal(isAgentWriteConflict("human", "agent", true), false);
  assert.equal(transitionPageOrigin("human", "agent", { acceptedAiDraft: true }), "mixed");
});

test("restore는 콘텐츠 출처와 무관하게 mixed revision을 만든다", () => {
  assert.equal(originForCreate("restore", "generated"), "mixed");
  assert.equal(transitionPageOrigin("human", "restore"), "mixed");
  assert.equal(transitionPageOrigin("generated", "restore"), "mixed");
});

test("internalOnly에서 external로 가는 경우만 정책 완화다", () => {
  assert.equal(isPolicyRelaxation("internalOnly", "external"), true);
  assert.equal(isPolicyRelaxation("external", "internalOnly"), false);
  assert.equal(isPolicyRelaxation("external", "external"), false);
});
