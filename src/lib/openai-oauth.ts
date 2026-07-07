/**
 * ChatGPT(Codex) OAuth — "로컬 단일 운영자" 전용 헬퍼.
 *
 * opencode(packages/core/src/plugin/provider/openai.ts)의 browser PKCE 흐름을 이 repo에 재현한 것이다.
 * 개인 ChatGPT Plus/Pro 구독을 이 앱 하나에서 쓰기 위한 것으로, `pnpm openai:login` 으로 한 번 로그인하면
 * 토큰이 로컬 파일에 저장되고 openai.ts 가 이를 ChatGPT 백엔드 호출에 쓴다.
 *
 * ⚠️ 개인 self-host 전용. 멀티유저/공개 배포에 쓰지 말 것 — 개인 구독으로 서비스를 구동하는 것은
 *    ChatGPT 약관 위반이다. (server-only 를 붙이지 않는다: CLI 스크립트와 서버가 함께 import 한다.)
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // OpenAI Codex 공개 client (opencode와 동일)
export const ISSUER = "https://auth.openai.com";
export const CALLBACK_PORT = 1455;
// ChatGPT 백엔드 — 표준 api.openai.com 이 아니다. (검증: EvanZhouDev/openai-oauth transport.ts)
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const REFRESH_MARGIN_MS = 60_000; // 만료 60초 전 미리 갱신(응답 도중 만료 회피)

export type OAuthStore = {
  access: string;
  refresh: string;
  accountId?: string;
  expires: number; // epoch ms
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
};

export function storePath(): string {
  return process.env.OPENAI_OAUTH_STORE || path.join(process.cwd(), ".openai-oauth.json");
}

export function storeExists(): boolean {
  return existsSync(storePath());
}

/** OPENAI_OAUTH_PERSONAL=1 + 토큰 존재 시에만 OAuth 경로 사용. OPENAI_BASE_URL 이 있으면 그쪽이 우선. */
export function oauthPersonalEnabled(): boolean {
  return process.env.OPENAI_OAUTH_PERSONAL === "1" && !process.env.OPENAI_BASE_URL && storeExists();
}

function readStore(): OAuthStore | null {
  if (!storeExists()) return null;
  try {
    return JSON.parse(readFileSync(storePath(), "utf8")) as OAuthStore;
  } catch {
    return null; // 손상/빈 파일 → 미로그인 취급(설정 페이지 락아웃 방지, 재로그인 유도)
  }
}

function writeStore(store: OAuthStore): void {
  const p = storePath();
  const tmp = `${p}.${process.pid}.tmp`; // 프로세스별 tmp — 동시 writer 간 충돌 회피
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort (Windows 등) */
  }
}

// --- PKCE (opencode 동일 규약) ---
function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const verifier = Array.from(randomBytes(43), (b) => chars[b % chars.length]).join("");
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authorizeURL(redirect: string, challenge: string, state: string): string {
  return `${ISSUER}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    // 이 client_id 로 검증된 값. 우리는 opencode 가 아니지만, codex 공개 client 에 묶인 값이라 유지한다.
    originator: "opencode",
  })}`;
}

/** refresh token 이 무효(회전 재사용 등)해 세션 재로그인이 필요한 경우. */
export class InvalidGrantError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "jimi-wiki/oauth" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 400 && /invalid_grant/.test(detail))
      throw new InvalidGrantError("refresh token 이 무효입니다 — 다시 로그인하세요.");
    throw new Error(`토큰 요청 실패 (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

function exchangeCode(code: string, redirect: string, verifier: string): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  );
}

function refreshTokens(refresh: string): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
  );
}

function toStore(t: TokenResponse, prev?: OAuthStore): OAuthStore {
  return {
    access: t.access_token,
    // 개선: refresh 응답이 refresh_token 을 안 돌려주는 경우 기존 값 유지(opencode 는 여기서 유실 가능).
    refresh: t.refresh_token ?? prev?.refresh ?? "",
    accountId: extractAccountID(t) ?? prev?.accountId,
    expires: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
}

let refreshInFlight: Promise<{ access: string; accountId?: string }> | null = null;

/** 유효한 access token 반환 — 만료 임박 시 refresh 후 저장. 토큰 없으면 throw. */
export async function getFreshAccess(): Promise<{ access: string; accountId?: string }> {
  const s = readStore();
  if (!s) throw new Error("ChatGPT OAuth 토큰이 없습니다 — 관리자 설정에서 로그인하세요.");
  if (Date.now() < s.expires - REFRESH_MARGIN_MS) return { access: s.access, accountId: s.accountId };
  if (!s.refresh) throw new Error("refresh token 이 없습니다 — 다시 로그인하세요.");
  // 같은 프로세스 동시 호출은 하나의 refresh 를 공유(중복 refresh → 토큰 회전 자멸 방지).
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshOnce(s).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshOnce(s: OAuthStore): Promise<{ access: string; accountId?: string }> {
  try {
    const next = toStore(await refreshTokens(s.refresh), s);
    writeStore(next);
    return { access: next.access, accountId: next.accountId };
  } catch (e) {
    // 크로스 프로세스 경쟁: 다른 프로세스(web↔worker)가 방금 refresh 해서 우리 refresh token 이
    // 회전됐을 수 있다. store 를 다시 읽어 더 새 토큰이 있으면 그걸 쓴다(무효 재로그인 회피).
    for (let i = 0; i < 3; i++) {
      await sleep(400);
      const s2 = readStore();
      if (s2 && s2.access !== s.access && Date.now() < s2.expires - REFRESH_MARGIN_MS) {
        return { access: s2.access, accountId: s2.accountId };
      }
    }
    // 회전 재사용으로 세션이 revoke 된 경우: 토큰을 지워 UI 가 재로그인을 유도하게 한다.
    if (e instanceof InvalidGrantError) logout();
    throw e;
  }
}

// id_token/access_token(JWT) payload 에서 chatgpt_account_id 추출.
function extractAccountID(t: TokenResponse): string | undefined {
  return claim(t.id_token) ?? claim(t.access_token);
}

function claim(token?: string): string | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const c = JSON.parse(Buffer.from(part, "base64url").toString()) as {
      chatgpt_account_id?: string;
      organizations?: Array<{ id: string }>;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return (
      c.chatgpt_account_id ??
      c["https://api.openai.com/auth"]?.chatgpt_account_id ??
      c.organizations?.[0]?.id
    );
  } catch {
    return undefined;
  }
}

/** 플랫폼 기본 브라우저로 URL 열기(best-effort, 의존성 없음). 실패해도 URL 은 콘솔에 출력된다. */
function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "win32")
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    // linux/WSL: WSL 이면 wslview 로 Windows 기본 브라우저를 열고, 아니면 xdg-open.
    else spawn("sh", ["-c", 'command -v wslview >/dev/null 2>&1 && wslview "$1" || xdg-open "$1"', "sh", url], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } catch {
    /* 브라우저 자동 실행 실패 시 사용자가 콘솔의 URL 을 직접 연다 */
  }
}

/**
 * 로컬 브라우저 OAuth 로그인(PKCE). localhost:1455 콜백을 받아 code 를 토큰으로 교환하고 저장한다.
 * CLI(`pnpm openai:login`)에서 호출. opencode 의 browser 흐름과 동일.
 */
export async function runBrowserLogin(): Promise<OAuthStore> {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(32));
  const redirect = `http://localhost:${CALLBACK_PORT}/auth/callback`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const value = url.searchParams.get("code");
      const page = (msg: string) =>
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">${msg}</body>`;
      const finish = (status: number, msg: string, err?: Error) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page(msg));
        server.close();
        if (err) reject(err);
        else resolve(value!);
      };
      if (err) return finish(400, `로그인 오류: ${err}`, new Error(err));
      if (!value || url.searchParams.get("state") !== state)
        return finish(400, "잘못된 콜백(state 불일치 또는 code 없음)", new Error("invalid oauth callback"));
      finish(200, "로그인 완료 — 이 창을 닫고 터미널로 돌아가세요.");
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT, "localhost", () => {
      const authUrl = authorizeURL(redirect, challenge, state);
      console.log("\n브라우저에서 ChatGPT 로그인을 완료하세요:\n" + authUrl + "\n");
      openBrowser(authUrl);
    });
  });

  const store = toStore(await exchangeCode(code, redirect, verifier));
  writeStore(store);
  return store;
}

// ---------- device-code 흐름 (UI/헤드리스 로그인) ----------
// opencode headless 흐름과 동일: usercode 발급 → 사용자가 다른 기기에서 코드 승인 → token 폴링.

export type DeviceAuth = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number; // 초 — 이 시간 안에 승인해야 함
};

async function deviceJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "jimi-wiki/oauth" },
    body: JSON.stringify(body),
  });
}

/** device 로그인 시작 — 사용자에게 보여줄 코드·URL 반환. */
export async function startDeviceAuth(): Promise<DeviceAuth> {
  const res = await deviceJson("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });
  if (!res.ok) throw new Error(`device auth 시작 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as {
    device_auth_id: string;
    user_code: string;
    interval?: string | number;
    expires_in?: string | number;
    verification_uri?: string;
    verification_uri_complete?: string;
  };
  return {
    deviceAuthId: d.device_auth_id,
    userCode: d.user_code,
    verificationUrl: d.verification_uri_complete || d.verification_uri || `${ISSUER}/codex/device`,
    interval: Math.max(Number(d.interval) || 5, 1),
    expiresIn: Math.max(Number(d.expires_in) || 900, 60),
  };
}

export type DevicePoll = { status: "pending" | "complete" | "error"; message?: string; accountId?: string };

/** device 토큰 1회 폴링. 승인 전이면 pending, 승인되면 토큰 교환·저장 후 complete. */
export async function pollDeviceToken(deviceAuthId: string, userCode: string): Promise<DevicePoll> {
  const res = await deviceJson("/api/accounts/deviceauth/token", {
    device_auth_id: deviceAuthId,
    user_code: userCode,
  });
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  if (!res.ok) return { status: "error", message: `${res.status}: ${(await res.text()).slice(0, 150)}` };
  const data = (await res.json()) as { authorization_code: string; code_verifier: string };
  try {
    const store = toStore(await exchangeCode(data.authorization_code, `${ISSUER}/deviceauth/callback`, data.code_verifier));
    writeStore(store);
    return { status: "complete", accountId: store.accountId };
  } catch (e) {
    // 일회용 authorization_code 는 이미 소진됨 — 처음부터 다시 로그인해야 한다.
    return { status: "error", message: "토큰 교환 실패(다시 로그인): " + (e as Error).message.slice(0, 120) };
  }
}

/** 로그아웃 — 저장된 토큰 삭제. */
export function logout(): void {
  const p = storePath();
  if (existsSync(p)) unlinkSync(p);
}

/** UI 표시용 상태(토큰 미노출). */
export function readStoreStatus(): { exists: boolean; accountId?: string; expires?: number } {
  const s = readStore();
  if (!s) return { exists: false };
  return { exists: true, accountId: s.accountId, expires: s.expires };
}
