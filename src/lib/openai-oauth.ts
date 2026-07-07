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
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  return JSON.parse(readFileSync(storePath(), "utf8")) as OAuthStore;
}

function writeStore(store: OAuthStore): void {
  const p = storePath();
  const tmp = `${p}.tmp`;
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

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "jimi-wiki/oauth" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
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

/** 유효한 access token 반환 — 만료 임박 시 refresh 후 저장. 토큰 없으면 throw. */
export async function getFreshAccess(): Promise<{ access: string; accountId?: string }> {
  const s = readStore();
  if (!s) throw new Error("ChatGPT OAuth 토큰이 없습니다 — `pnpm openai:login` 을 먼저 실행하세요.");
  if (Date.now() < s.expires - REFRESH_MARGIN_MS) return { access: s.access, accountId: s.accountId };
  if (!s.refresh) throw new Error("refresh token 이 없습니다 — `pnpm openai:login` 으로 다시 로그인하세요.");
  const next = toStore(await refreshTokens(s.refresh), s);
  writeStore(next);
  return { access: next.access, accountId: next.accountId };
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
