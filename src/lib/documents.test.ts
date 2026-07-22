import test from "node:test";
import assert from "node:assert/strict";
import {
  DocumentInputError,
  MAX_DOCUMENT_APPEND_BYTES,
  appendDocumentBody,
  assertDocumentBodySize,
  containsSecretMaterial,
  formatWorklog,
  parseDocumentDate,
  parseDocumentType,
} from "./documents";

test("DocumentType은 닫힌 집합이며 잘못된 값으로 강등하지 않는다", () => {
  assert.equal(parseDocumentType(undefined, "general"), "general");
  assert.equal(parseDocumentType("worklog"), "worklog");
  assert.equal(parseDocumentType("answer"), null);
});

test("documentAt은 ISO date-time만 받고 유효하지 않은 값은 거부한다", () => {
  assert.equal(parseDocumentDate("2026-07-21T12:30:00+09:00")?.toISOString(), "2026-07-21T03:30:00.000Z");
  assert.equal(parseDocumentDate("2026-07-21"), null);
  assert.equal(parseDocumentDate("not-a-date"), null);
});

test("worklog는 일곱 고정 섹션을 순서대로 항상 포함한다", () => {
  assert.equal(
    formatWorklog({ 목표: "완료", 검증: "테스트 통과" }),
    [
      "## 목표\n\n완료",
      "## 변경 사항\n\n",
      "## 결정\n\n",
      "## 문제와 해결\n\n",
      "## 검증\n\n테스트 통과",
      "## 남은 작업\n\n",
      "## 참고 자료\n\n",
    ].join("\n\n"),
  );
});

test("append는 두 줄 경계로 결정적으로 이어 붙이고 byte 상한을 적용한다", () => {
  assert.equal(appendDocumentBody("기존", "추가"), "기존\n\n추가");
  assert.equal(appendDocumentBody("", "추가"), "추가");
  assert.throws(
    () => assertDocumentBodySize("가".repeat(Math.ceil(MAX_DOCUMENT_APPEND_BYTES / 3) + 1), true),
    (error) => error instanceof DocumentInputError && error.code === "document_body_too_large" && error.status === 413,
  );
});

test("대표적인 비밀 키 material을 문서 저장 전에 감지한다", () => {
  assert.equal(containsSecretMaterial("ordinary project note"), false);
  assert.equal(containsSecretMaterial("-----BEGIN PRIVATE KEY-----\nabc"), true);
  assert.equal(containsSecretMaterial("token ghp_abcdefghijklmnopqrstuvwxyz123456"), true);
});
