import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  effectiveOpenAITransport,
  openaiTransportAvailable,
  shouldUseOAuthModelDefault,
} from "./model-config";

test("OAuth 자동 모델은 oauth transport와 OAuth store가 모두 있을 때만 사용한다", () => {
  assert.equal(shouldUseOAuthModelDefault("oauth", true), true);
  assert.equal(shouldUseOAuthModelDefault("oauth", false), false);
  assert.equal(shouldUseOAuthModelDefault("apikey", true), false);
  assert.equal(shouldUseOAuthModelDefault("proxy", true), false);
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** env 를 만지는 테스트는 끝나고 반드시 되돌린다(다른 테스트 파일과 프로세스를 공유한다). */
async function withEnv(
  patch: Record<string, string | undefined>,
  run: () => Promise<void> | void,
): Promise<void> {
  const keys = [...Object.keys(patch), "OPENAI_OAUTH_STORE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  // OAuth 판정이 개발자 머신의 실제 토큰 파일을 읽지 않도록 없는 경로로 고정한다.
  const dir = mkdtempSync(path.join(tmpdir(), "jimi-transport-test-"));
  process.env.OPENAI_OAUTH_STORE = path.join(dir, "absent.json");
  for (const [k, v] of Object.entries(patch)) setEnv(k, v);
  try {
    await run();
  } finally {
    for (const k of keys) setEnv(k, saved[k]);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("프록시용 더미 키는 API 키 자격증명으로 인정하지 않는다", async () => {
  // proxy 경로는 @ai-sdk 가 값을 요구해서 OPENAI_API_KEY 에 더미를 채워둔다. 그걸 사용 가능으로
  // 보면 관리자가 "API 키" 를 고를 수 있고, 그 순간 모든 요청이 api.openai.com 에서 거부된다.
  await withEnv({ OPENAI_API_KEY: "codex-local", OPENAI_BASE_URL: undefined }, () => {
    assert.equal(openaiTransportAvailable("apikey"), false);
  });
  await withEnv({ OPENAI_API_KEY: "", OPENAI_BASE_URL: undefined }, () => {
    assert.equal(openaiTransportAvailable("apikey"), false);
  });
});

test("진짜 sk- 키는 그대로 사용 가능하다", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test-not-a-real-key", OPENAI_BASE_URL: undefined }, () => {
    assert.equal(openaiTransportAvailable("apikey"), true);
  });
  // env 값에 공백이 섞여도 진짜 키를 놓치지 않는다(같은 파일의 transport 추론도 trim 한다).
  await withEnv({ OPENAI_API_KEY: "  sk-test-not-a-real-key  ", OPENAI_BASE_URL: undefined }, () => {
    assert.equal(openaiTransportAvailable("apikey"), true);
  });
});

test("선택한 방식이 불가하면 더미 키가 아니라 살아있는 방식으로 넘어간다", async () => {
  // oauth 를 골랐지만 토큰이 없는 상황. 예전에는 폴백 1순위가 apikey 라 더미 키로 넘어갔다.
  await withEnv(
    {
      OPENAI_TRANSPORT: "oauth",
      OPENAI_API_KEY: "codex-local",
      OPENAI_BASE_URL: "http://127.0.0.1:10531/v1",
    },
    () => {
      assert.equal(openaiTransportAvailable("oauth"), false, "토큰이 없어야 하는 전제");
      assert.equal(effectiveOpenAITransport(), "proxy");
    },
  );
});

test("쓸 수 있는 방식이 하나도 없으면 고른 값을 그대로 돌려준다", async () => {
  await withEnv(
    { OPENAI_TRANSPORT: "apikey", OPENAI_API_KEY: "codex-local", OPENAI_BASE_URL: undefined },
    () => {
      assert.equal(effectiveOpenAITransport(), "apikey");
    },
  );
});
