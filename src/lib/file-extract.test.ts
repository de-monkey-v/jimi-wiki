import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseExternalOcr } from "./file-extract";

test("external AI가 금지되면 provider가 있어도 OCR dispatch를 허용하지 않는다", () => {
  assert.equal(shouldUseExternalOcr(false, true, "wiki-1"), false);
});

test("OCR은 external 허용, provider, wiki policy scope가 모두 있을 때만 가능하다", () => {
  assert.equal(shouldUseExternalOcr(true, false, "wiki-1"), false);
  assert.equal(shouldUseExternalOcr(true, true), false);
  assert.equal(shouldUseExternalOcr(true, true, "wiki-1"), true);
});
