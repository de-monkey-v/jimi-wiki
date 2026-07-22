import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseOAuthModelDefault } from "./model-config";

test("OAuth 자동 모델은 oauth transport와 OAuth store가 모두 있을 때만 사용한다", () => {
  assert.equal(shouldUseOAuthModelDefault("oauth", true), true);
  assert.equal(shouldUseOAuthModelDefault("oauth", false), false);
  assert.equal(shouldUseOAuthModelDefault("apikey", true), false);
  assert.equal(shouldUseOAuthModelDefault("proxy", true), false);
});
