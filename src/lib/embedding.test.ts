import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddingReadiness } from "./embedding";

async function withEmbeddingEnv(
  vars: Record<string, string | undefined>,
  mockFetch: typeof fetch,
  fn: () => Promise<void>,
) {
  const savedEnv = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = mockFetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("local embedding readiness는 TEI /health 실제 응답을 요구한다", async () => {
  let requested = "";
  await withEmbeddingEnv(
    { EMBED_PROVIDER: "local", EMBED_BASE_URL: "http://127.0.0.1:8080" },
    (async (input) => {
      requested = String(input);
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    async () => {
      const status = await embeddingReadiness();
      assert.equal(status.ready, true);
      assert.equal(status.enabled, true);
      assert.equal(requested, "http://127.0.0.1:8080/health");
    },
  );
});

test("local embedding readiness는 연결 실패와 비정상 응답을 fail-closed한다", async () => {
  await withEmbeddingEnv(
    { EMBED_PROVIDER: "local", EMBED_BASE_URL: "http://127.0.0.1:8080" },
    (async () => new Response(null, { status: 503 })) as typeof fetch,
    async () => assert.equal((await embeddingReadiness()).ready, false),
  );
  await withEmbeddingEnv(
    { EMBED_PROVIDER: "local", EMBED_BASE_URL: "http://127.0.0.1:8080" },
    (async () => { throw new Error("offline"); }) as typeof fetch,
    async () => assert.equal((await embeddingReadiness()).ready, false),
  );
});

test("Gemini 선택 경로는 readiness에서 외부 API를 호출하지 않는다", async () => {
  let called = false;
  await withEmbeddingEnv(
    { EMBED_PROVIDER: "gemini", EMBED_BASE_URL: undefined, GEMINI_API_KEY: undefined },
    (async () => {
      called = true;
      throw new Error("must not be called");
    }) as typeof fetch,
    async () => {
      const status = await embeddingReadiness();
      assert.equal(status.ready, true);
      assert.equal(status.enabled, false);
      assert.equal(called, false);
    },
  );
});
