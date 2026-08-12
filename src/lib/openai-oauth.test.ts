/**
 * openai-oauth 어댑터의 공개 계약 테스트.
 *
 * 프로토콜은 subauth 가 담당하지만 소비 지점 12곳이 의존하는 계약(상수·함수 시그니처·반환 모양)은
 * 이 파일이 지킨다. 실제 토큰 파일(.openai-oauth.json)은 절대 건드리지 않는다 — 모든 테스트가
 * OPENAI_OAUTH_STORE 로 임시 경로를 가리킨 뒤 원래 env 를 복원한다. 네트워크도 나가지 않는다:
 * 토큰 엔드포인트 호출은 globalThis.fetch 를 가로채 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CALLBACK_PORT,
  CLIENT_ID,
  CODEX_BASE_URL,
  ISSUER,
  generatePKCE,
  getFreshAccess,
  logout,
  oauthPersonalEnabled,
  pollDeviceToken,
  readStoreStatus,
  startDeviceAuth,
  storeExists,
  storePath,
} from "./openai-oauth";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** 임시 store 경로에서 실행하고, env 와 임시 디렉터리를 반드시 되돌린다. */
async function withTempStore(run: (file: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "jimi-oauth-test-"));
  const saved = {
    store: process.env.OPENAI_OAUTH_STORE,
    personal: process.env.OPENAI_OAUTH_PERSONAL,
    baseUrl: process.env.OPENAI_BASE_URL,
  };
  process.env.OPENAI_OAUTH_STORE = path.join(dir, "store.json");
  try {
    await run(process.env.OPENAI_OAUTH_STORE);
  } finally {
    setEnv("OPENAI_OAUTH_STORE", saved.store);
    setEnv("OPENAI_OAUTH_PERSONAL", saved.personal);
    setEnv("OPENAI_BASE_URL", saved.baseUrl);
    rmSync(dir, { recursive: true, force: true });
  }
}

type Call = {
  url: string;
  /** form-encoded 본문(토큰 엔드포인트). device 엔드포인트는 JSON 이므로 raw 를 쓴다. */
  body: URLSearchParams;
  raw: string;
  headers: Record<string, string>;
};

/** 토큰 엔드포인트 호출을 가로채 기록하고 준비된 응답을 돌려준다. */
async function withFetch(
  respond: (call: Call) => { status: number; body: unknown },
  run: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    const raw = i.body ?? "";
    const call: Call = {
      url: String(url),
      body: new URLSearchParams(raw),
      raw,
      headers: i.headers ?? {},
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("공개 상수는 이전 인라인 구현과 같은 값이다", () => {
  assert.equal(CLIENT_ID, "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(ISSUER, "https://auth.openai.com");
  assert.equal(CALLBACK_PORT, 1455);
  assert.equal(CODEX_BASE_URL, "https://chatgpt.com/backend-api/codex");
});

test("generatePKCE: RFC 7636 최소 길이의 unreserved verifier 와 S256 challenge", () => {
  const { verifier, challenge } = generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9\-_]{43}$/);
  assert.notEqual(verifier, generatePKCE().verifier);
});

test("storePath: OPENAI_OAUTH_STORE 우선, 없으면 cwd/.openai-oauth.json", async () => {
  await withTempStore((file) => {
    assert.equal(storePath(), file);
    delete process.env.OPENAI_OAUTH_STORE;
    assert.equal(storePath(), path.join(process.cwd(), ".openai-oauth.json"));
  });
});

test("로그인 전: 상태 조회는 예외 없이 미로그인을 보고한다", async () => {
  await withTempStore(async () => {
    process.env.OPENAI_OAUTH_PERSONAL = "1";
    delete process.env.OPENAI_BASE_URL;

    assert.equal(storeExists(), false);
    assert.equal(oauthPersonalEnabled(), false); // 게이트가 켜져 있어도 토큰이 없으면 false
    assert.deepEqual(readStoreStatus(), { exists: false });

    // 토큰이 없으면 던지되, 소비자가 분기할 수 있는 code 를 달고 던진다.
    await assert.rejects(getFreshAccess(), (e: Error & { code?: string }) => {
      assert.equal(e.code, "not_authenticated");
      return true;
    });
  });
});

test("손상된 토큰 파일은 미로그인으로 취급한다(파일 존재가 아니라 세션 존재)", async () => {
  await withTempStore(async (file) => {
    writeFileSync(file, "{ 잘린 JSON", { mode: 0o600 });
    assert.equal(storeExists(), false);
    assert.deepEqual(readStoreStatus(), { exists: false });
  });
});

test("유효한 세션은 상태로 노출되고 토큰은 새지 않는다", async () => {
  await withTempStore(async (file) => {
    const expires = Date.now() + 3_600_000;
    writeFileSync(
      file,
      JSON.stringify({ access: "a1", refresh: "r1", accountId: "acc-1", expires }),
      { mode: 0o600 },
    );

    assert.equal(storeExists(), true);
    const status = readStoreStatus();
    assert.deepEqual(status, { exists: true, accountId: "acc-1", expires });
    assert.equal("access" in status, false);
    assert.equal("refresh" in status, false);
  });
});

test("만료가 남은 세션은 refresh 없이 그대로 쓴다", async () => {
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({
        access: "a1",
        refresh: "r1",
        accountId: "acc-1",
        expires: Date.now() + 3_600_000,
      }),
      { mode: 0o600 },
    );

    await withFetch(
      () => assert.fail("만료 전에는 토큰 엔드포인트를 호출하면 안 된다"),
      async (calls) => {
        assert.deepEqual(await getFreshAccess(), { access: "a1", accountId: "acc-1" });
        assert.equal(calls.length, 0);
      },
    );
  });
});

test("만료 임박 세션은 refresh 되고 회전된 토큰이 파일에 저장된다", async () => {
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({ access: "old", refresh: "r1", accountId: "acc-1", expires: Date.now() - 1000 }),
      { mode: 0o600 },
    );

    await withFetch(
      () => ({
        status: 200,
        body: { access_token: "new", refresh_token: "r2", expires_in: 3600 },
      }),
      async (calls) => {
        const grant = await getFreshAccess();

        // 반환된 access 는 새 토큰이고, 계정은 이전 세션에서 이어진다.
        assert.deepEqual(grant, { access: "new", accountId: "acc-1" });

        // 요청은 이 앱의 User-Agent 로, 이 client 의 refresh_token grant 로 나갔다.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `${ISSUER}/oauth/token`);
        assert.equal(calls[0].body.get("grant_type"), "refresh_token");
        assert.equal(calls[0].body.get("refresh_token"), "r1");
        assert.equal(calls[0].body.get("client_id"), CLIENT_ID);
        assert.equal(calls[0].headers["User-Agent"], "jimi-wiki/oauth");

        // 회전된 refresh 토큰이 디스크에 남아야 다음 프로세스가 이어받는다.
        const saved = JSON.parse(readFileSync(file, "utf8")) as {
          access: string;
          refresh: string;
          accountId?: string;
          expires: number;
        };
        assert.equal(saved.access, "new");
        assert.equal(saved.refresh, "r2");
        assert.equal(saved.accountId, "acc-1");
        assert.ok(saved.expires > Date.now(), "새 만료는 미래여야 한다");
      },
    );
  });
});

test("logout 은 세션을 지우고, 지운 뒤 조회는 미로그인이다", async () => {
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({ access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );
    assert.equal(storeExists(), true);

    logout();

    assert.equal(storeExists(), false);
    assert.deepEqual(readStoreStatus(), { exists: false });
    logout(); // 두 번째 호출도 조용히 성공해야 한다(이미 없음 = 성공)
  });
});

test("동시 호출은 refresh 를 한 번만 수행한다", async () => {
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({ access: "old", refresh: "r1", accountId: "acc-1", expires: Date.now() - 1000 }),
      { mode: 0o600 },
    );

    await withFetch(
      () => ({ status: 200, body: { access_token: "new", refresh_token: "r2", expires_in: 3600 } }),
      async (calls) => {
        // await 없이 동시에 띄운다 — 서버는 refresh 토큰을 회전시키므로 두 번 교환하면
        // 두 번째가 이미 쓴 토큰을 재사용한 것이 되어 세션 전체가 revoke 된다.
        const grants = await Promise.all([getFreshAccess(), getFreshAccess(), getFreshAccess()]);

        assert.equal(calls.length, 1, "동시 호출은 하나의 refresh 를 공유해야 한다");
        for (const grant of grants) {
          assert.deepEqual(grant, { access: "new", accountId: "acc-1" });
        }
      },
    );
  });
});

test("취소된 호출만 거부되고, 같은 refresh 를 기다리던 호출은 결과를 받는다", async () => {
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({ access: "old", refresh: "r1", accountId: "acc-1", expires: Date.now() - 1000 }),
      { mode: 0o600 },
    );

    await withFetch(
      () => ({ status: 200, body: { access_token: "new", refresh_token: "r2", expires_in: 3600 } }),
      async (calls) => {
        const controller = new AbortController();
        const cancelled = getFreshAccess(controller.signal);
        const waiting = getFreshAccess();
        controller.abort();

        await assert.rejects(cancelled, "취소한 호출은 거부되어야 한다");
        // 취소가 공유 중인 refresh 를 죽이면 다른 대기자까지 로그인을 잃는다.
        assert.deepEqual(await waiting, { access: "new", accountId: "acc-1" });
        assert.equal(calls.length, 1);
      },
    );
  });
});

test("invalid_grant 는 토큰 파일을 지우지 않고, 그 세션은 재로그인까지 건너뛴다", async () => {
  await withTempStore(async (file) => {
    process.env.OPENAI_OAUTH_PERSONAL = "1";
    delete process.env.OPENAI_BASE_URL;
    const dead = { access: "old", refresh: "r1", accountId: "acc-1", expires: Date.now() - 1000 };
    writeFileSync(file, JSON.stringify(dead), { mode: 0o600 });

    await withFetch(
      () => ({ status: 400, body: { error: "invalid_grant" } }),
      async (calls) => {
        // 참고: 첫 호출은 subauth 의 회전 복구 예산(형제 프로세스의 토큰 왕복을 기다리는 시간)을
        // 끝까지 소진하므로 십수 초 걸린다. 그 대기가 세션당 한 번뿐이라는 것이 이 테스트의 요점이다.
        await assert.rejects(getFreshAccess(), (e: Error & { code?: string }) => {
          assert.equal(e.code, "invalid_grant");
          return true;
        });

        // 형제 프로세스가 방금 회전시켰을 수 있다 — 파일을 지우면 그 세션까지 잃는다.
        assert.ok(existsSync(file), "토큰 파일이 남아 있어야 한다");
        const saved = JSON.parse(readFileSync(file, "utf8")) as { refresh: string };
        assert.equal(saved.refresh, "r1");

        // 죽은 세션은 미로그인으로 보고되어 transport 가 살아있는 자격증명으로 폴백하고,
        // 설정 화면도 "로그인됨" 대신 미로그인으로 그린다(같은 화면에서 oauth 는 이미 불가다).
        assert.equal(storeExists(), false);
        assert.equal(oauthPersonalEnabled(), false);
        assert.deepEqual(readStoreStatus(), { exists: false });

        // 두 번째부터는 토큰 엔드포인트를 다시 치지 않는다(매 요청 12초를 물지 않는다).
        const before = calls.length;
        await assert.rejects(getFreshAccess());
        assert.equal(calls.length, before, "죽은 세션에 다시 요청하면 안 된다");

        // logout() 은 마커를 명시적으로 푼다. expires 가 그대로인 세션을 다시 써서 확인한다 —
        // 자동 해제(expires 변화)로는 풀릴 수 없는 조건이라, logout() 이 풀지 않으면 여기서 걸린다.
        logout();
        writeFileSync(
          file,
          JSON.stringify({ access: "relogin", refresh: "r9", accountId: "acc-1", expires: dead.expires }),
          { mode: 0o600 },
        );
        assert.equal(storeExists(), true, "logout() 이 마커를 풀어야 한다");

        // 재로그인(= 새 세션이 파일에 기록됨)이어도 마커가 저절로 풀린다.
        writeFileSync(
          file,
          JSON.stringify({ access: "fresh", refresh: "r2", accountId: "acc-1", expires: Date.now() + 3_600_000 }),
          { mode: 0o600 },
        );
        assert.equal(storeExists(), true);
        assert.deepEqual(readStoreStatus().exists, true);
        assert.deepEqual(await getFreshAccess(), { access: "fresh", accountId: "acc-1" });
      },
    );
  });
});

test("device 폴링은 deviceAuthId 와 userCode 를 각자의 필드로 보낸다", async () => {
  await withTempStore(async () => {
    await withFetch(
      () => ({ status: 403, body: {} }), // 아직 승인 전
      async (calls) => {
        const result = await pollDeviceToken("DEV-AUTH-ID", "USER-CODE");

        assert.deepEqual(result, { status: "pending" });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `${ISSUER}/api/accounts/deviceauth/token`);
        // 두 값을 맞바꿔 보내면 사용자는 승인했는데 화면이 영원히 대기한다.
        const sent = JSON.parse(calls[0].raw) as { device_auth_id: string; user_code: string };
        assert.equal(sent.device_auth_id, "DEV-AUTH-ID");
        assert.equal(sent.user_code, "USER-CODE");
      },
    );
  });
});

test("device 로그인 시작은 사용자에게 보여줄 코드와 URL 을 그대로 전달한다", async () => {
  await withTempStore(async () => {
    await withFetch(
      () => ({
        status: 200,
        body: {
          device_auth_id: "D-1",
          user_code: "WXYZ-1234",
          verification_uri_complete: "https://auth.openai.com/codex/device?code=WXYZ-1234",
          interval: 5,
          expires_in: 900,
        },
      }),
      async (calls) => {
        const auth = await startDeviceAuth();

        assert.equal(calls[0].url, `${ISSUER}/api/accounts/deviceauth/usercode`);
        assert.equal(JSON.parse(calls[0].raw).client_id, CLIENT_ID);
        assert.equal(auth.deviceAuthId, "D-1");
        assert.equal(auth.userCode, "WXYZ-1234");
        assert.equal(auth.verificationUrl, "https://auth.openai.com/codex/device?code=WXYZ-1234");
        assert.equal(auth.interval, 5);
        assert.equal(auth.expiresIn, 900);
      },
    );
  });
});

test("codex fetch 배선: 매 요청에 토큰·originator·store:false 가 붙는다", async () => {
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({ access: "a1", refresh: "r1", accountId: "acc-1", expires: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );

    // openai.ts 가 만드는 것과 같은 조합. codex 백엔드는 이 헤더들이 없으면 400 을 준다.
    const { createCodexFetch } = await import("subauth");
    const seen: { headers: Headers; body: string }[] = [];
    const codexFetch = createCodexFetch(
      { getFreshAccess },
      {
        fetch: (async (_input: unknown, init: RequestInit | undefined) => {
          seen.push({ headers: new Headers(init?.headers), body: String(init?.body ?? "") });
          return new Response("{}", { status: 200 });
        }) as typeof globalThis.fetch,
      },
    );

    await codexFetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.get("authorization"), "Bearer a1");
    assert.equal(seen[0].headers.get("chatgpt-account-id"), "acc-1");
    assert.equal(seen[0].headers.get("originator"), "codex_cli_rs");
    assert.ok(seen[0].headers.get("session_id"), "session_id 가 있어야 한다");
    const sent = JSON.parse(seen[0].body) as { store: boolean; model: string };
    assert.equal(sent.store, false, "codex 백엔드는 store:false 를 요구한다");
    assert.equal(sent.model, "gpt-5.6-sol");
  });
});

test("토큰 엔드포인트가 요청을 되비춰도 에러에 refresh 토큰이 새지 않는다", async () => {
  const secret = "r1-do-not-leak-this-refresh-token";
  await withTempStore(async (file) => {
    writeFileSync(
      file,
      JSON.stringify({ access: "old", refresh: secret, expires: Date.now() - 1000 }),
      { mode: 0o600 },
    );

    await withFetch(
      // 디버그 프록시나 잘못 설정된 게이트웨이가 요청 본문을 그대로 되돌려주는 상황.
      (call) => ({
        status: 400,
        body: { error: "server_error", error_description: `echo: ${call.body.toString()}` },
      }),
      async () => {
        await assert.rejects(getFreshAccess(), (e: Error) => {
          assert.ok(
            !e.message.includes(secret),
            `에러 메시지에 refresh 토큰이 노출됐다: ${e.message}`,
          );
          return true;
        });
      },
    );
  });
});
