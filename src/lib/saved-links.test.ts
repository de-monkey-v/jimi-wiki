import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSavedLinkSummary, normalizeSavedLinkUrl, SAVED_LINK_SUMMARY_MAX } from "./saved-links";

test("읽을거리 URL은 알려진 추적 파라미터만 제거한다", () => {
  assert.equal(
    normalizeSavedLinkUrl("https://example.com/a?id=7&utm_source=naver&utm_medium=referral#section"),
    "https://example.com/a?id=7#section",
  );
  assert.equal(
    normalizeSavedLinkUrl("https://example.com/a?signature=a%2Bb&ref=home&FBCLID=x"),
    "https://example.com/a?signature=a%2Bb&ref=home",
  );
  assert.equal(normalizeSavedLinkUrl("https://example.com/path?b=2&a=1"), "https://example.com/path?b=2&a=1");
});

test("읽을거리 URL은 http/https만 허용한다", () => {
  assert.throws(() => normalizeSavedLinkUrl("javascript:alert(1)"), /invalid_url/);
  assert.throws(() => normalizeSavedLinkUrl("not a url"), /invalid_url/);
});

test("명시적 요약은 공백을 정리하고 2000자로 제한한다", () => {
  assert.equal(normalizeSavedLinkSummary("  핵심 요약  "), "핵심 요약");
  assert.equal(normalizeSavedLinkSummary("   "), null);
  assert.throws(() => normalizeSavedLinkSummary("x".repeat(SAVED_LINK_SUMMARY_MAX + 1)), /summary_too_large/);
});
