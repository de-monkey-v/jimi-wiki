/**
 * ChatGPT(Codex) OAuth — "로컬 단일 운영자" 전용 헬퍼.
 *
 * 프로토콜(PKCE·토큰 교환·refresh·device 흐름)은 subauth 패키지가 담당하고, 이 파일에는 앱 정책만
 * 남는다: 토큰 파일을 어디에 둘지(storePath)와 OAuth 경로를 켤지(oauthPersonalEnabled). subauth 는
 * 기본 경로도, 환경변수 조회도 갖지 않는 것이 불변식이라 그 두 가지는 여기 있어야 한다.
 * 공개 계약(함수 이름·시그니처)은 이전 인라인 구현과 동일하게 유지하므로 소비자는 바뀌지 않는다.
 *
 * ⚠️ 개인 self-host 전용. 멀티유저/공개 배포에 쓰지 말 것 — 개인 구독으로 서비스를 구동하는 것은
 *    ChatGPT 약관 위반이다. (server-only 를 붙이지 않는다: CLI 스크립트와 서버가 함께 import 한다.)
 */
import path from "node:path";
import {
  CLIENT_ID,
  CODEX_BASE_URL,
  DEFAULT_CALLBACK_PORT,
  ISSUER,
  InvalidGrantError,
  createChatGPTAuth,
  fileTokenStore,
  generatePKCE,
  type AuthStatus,
  type ChatGPTAuth,
  type DeviceAuth,
  type DevicePoll,
  type OAuthTokens,
} from "subauth";

export { CLIENT_ID, CODEX_BASE_URL, ISSUER, InvalidGrantError, generatePKCE };
export type { DeviceAuth, DevicePoll };

/** 콜백 포트 — 이 client_id 가 허용하는 redirect URI 에 묶인 값이다. */
export const CALLBACK_PORT = DEFAULT_CALLBACK_PORT;

/** 토큰 파일 포맷. subauth 가 id_token 을 함께 보존하는 것 외에는 이전과 같다(기존 파일 그대로 읽힌다). */
export type OAuthStore = OAuthTokens;

/** 토큰 요청에 실리는 User-Agent — 이전 구현과 같은 값을 유지한다. */
const USER_AGENT = "jimi-wiki/oauth";

/** 토큰 파일 위치 — 앱 정책이다. subauth 는 기본 경로를 갖지 않는다. */
export function storePath(): string {
  return process.env.OPENAI_OAUTH_STORE || path.join(process.cwd(), ".openai-oauth.json");
}

// storePath() 는 호출마다 평가된다(스크립트·테스트가 env 로 경로를 바꾼다). 경로가 그대로면 같은
// auth 를 재사용하고 바뀌면 새로 만든다. 동시 refresh 중복은 subauth 가 store 경로 기준으로 이미
// 막으므로 이 캐시는 순수한 재사용일 뿐 정확성의 근거가 아니다.
let cached: { path: string; auth: ChatGPTAuth } | null = null;

function auth(): ChatGPTAuth {
  // 캐시 키는 절대경로다. env 에 상대 경로를 준 채 cwd 가 바뀌면 같은 문자열이 다른 파일을
  // 가리키므로, 원본 문자열로 비교하면 지난 경로의 auth 를 계속 쓰게 된다.
  const p = path.resolve(storePath());
  if (!cached || cached.path !== p) {
    cached = { path: p, auth: createChatGPTAuth({ store: fileTokenStore(p), userAgent: USER_AGENT }) };
  }
  return cached.auth;
}

/**
 * revoke 된 세션을 이 프로세스 안에서만 기억한다.
 *
 * subauth 는 invalid_grant 를 받아도 토큰 파일을 지우지 않는다. 형제 프로세스(web↔worker)가
 * 방금 refresh 토큰을 회전시킨 직후일 수 있고, 그때 파일을 지우면 subauth 의 compare-and-swap 이
 * 그 형제의 쓰기를 거부해(NotAuthenticatedError) 서버가 막 발급한 자격증명을 통째로 잃는다.
 * 그래서 파일은 건드리지 않고 "이 세션은 죽었다" 는 사실만 메모리에 남긴다.
 *
 * 세션 식별자로 expires 를 쓴다 — 재로그인이든 성공적인 refresh 든 이 값을 반드시 바꾸므로
 * 마커가 저절로 풀린다. 이전 구현이 logout() 으로 얻던 두 가지, 즉 (1) 죽은 세션에 매 요청
 * 매달리지 않는 것과 (2) effectiveOpenAITransport 가 apikey/proxy 로 폴백하는 것을 이 마커가
 * 대신한다. 다만 파일을 지우지 않으므로 다른 프로세스에는 전파되지 않는다 — 각 프로세스가
 * 처음 한 번씩 스스로 알아낸다.
 *
 * 회전 복구 예산은 subauth 기본값(30 × 400ms ≈ 12초)을 그대로 쓴다. 이전 구현의 3 × 400ms 는
 * 너무 짧아서, 형제가 2초에 회전시킨 **살아 있는** 세션을 죽은 것으로 보고 파일을 지웠다.
 * 그 예산은 web↔worker 의 compare-and-swap 을 실제로 보호하는 값이라 줄이지 않는다 — 대신
 * 이 마커가 그 비용을 프로세스당·세션당 한 번으로 묶는다.
 */
let revokedExpires: number | null = null;

function isInvalidGrant(error: unknown): boolean {
  // CJS/ESM 두 사본이 로드되면 instanceof 가 갈라질 수 있어 code 로도 확인한다.
  return (
    error instanceof InvalidGrantError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "invalid_grant")
  );
}

function sessionRevoked(): boolean {
  if (revokedExpires === null) return false; // 정상 경로에는 아무 비용도 붙지 않는다
  const status = auth().status();
  if (!status.exists || status.expires !== revokedExpires) {
    revokedExpires = null; // 다른 세션으로 바뀌었다 — 마커는 더 이상 유효하지 않다
    return false;
  }
  return true;
}

/**
 * 죽은 세션을 기록한다. expires 는 **실패한 세션의 것**이어야 한다 — 실패한 뒤에 파일을 다시
 * 읽으면 그 사이 형제가 기록한 새 세션에 마커가 찍혀, 살아 있는 세션을 죽은 것으로 만든다.
 */
function markRevoked(expires: number | null): void {
  if (revokedExpires === expires) return; // 동시 요청이 같은 세션에 몰려도 한 번만 알린다
  revokedExpires = expires;
  console.warn(
    "[openai-oauth] refresh 가 invalid_grant 로 거부됐습니다 — 이 프로세스는 재로그인 전까지 " +
      "OAuth 경로를 건너뜁니다(토큰 파일은 형제 프로세스를 위해 그대로 둡니다).",
  );
}

function clearRevoked(): void {
  revokedExpires = null;
}

/**
 * 저장된 세션 존재 여부.
 *
 * 이전 구현의 "파일이 있는가" 에서 "읽을 수 있는 세션이 있는가" 로 좁아졌다 — 손상되거나 잘린
 * 파일은 이제 false 다. 그 편이 소비자(설정 페이지·worker·모델 기본값)의 의도에 맞다: 파일만 있고
 * 내용이 깨진 상태를 "로그인됨" 으로 표시하면 첫 요청에서 실패한다.
 *
 * revoke 가 확인된 세션도 false 다 — 그래야 transport 선택이 살아 있는 자격증명으로 폴백한다.
 */
export function storeExists(): boolean {
  return auth().exists() && !sessionRevoked();
}

/** OPENAI_OAUTH_PERSONAL=1 + 토큰 존재 시에만 OAuth 경로 사용. OPENAI_BASE_URL 이 있으면 그쪽이 우선. */
export function oauthPersonalEnabled(): boolean {
  return process.env.OPENAI_OAUTH_PERSONAL === "1" && !process.env.OPENAI_BASE_URL && storeExists();
}

/**
 * 유효한 access token 반환 — 만료 임박 시 refresh 후 저장. 토큰이 없으면 throw 한다.
 *
 * 에러는 이제 subauth 의 타입 있는 에러(`code` 필드 보유)이고 메시지는 영어다. 분기는 메시지가
 * 아니라 `code` 로 하는 편이 안전하다.
 */
export async function getFreshAccess(
  signal?: AbortSignal,
): Promise<{ access: string; accountId?: string }> {
  // 죽은 세션에 회전 복구 예산(약 12초)을 매 요청 다시 물지 않는다. 그 대기는 형제 프로세스의
  // 토큰 왕복을 기다리는 값이라 짧게 줄일 수 없고, 세션당 한 번이면 충분하다.
  if (sessionRevoked()) throw new InvalidGrantError();
  // 어느 세션을 시도하는지 미리 붙잡는다. 실패한 뒤에 읽으면 그 사이 형제가 회전시켜 기록한
  // 새 세션에 마커가 찍힌다 — 살아 있는 세션이 강등되고, expires 가 같으니 자동 해제도 안 된다.
  const attempted = auth().status().expires ?? null;
  try {
    const grant = await auth().getFreshAccess(signal);
    clearRevoked();
    return grant;
  } catch (error) {
    if (isInvalidGrant(error)) markRevoked(attempted);
    throw error;
  }
}

/** device 로그인 시작 — 사용자에게 보여줄 코드·URL 반환. */
export function startDeviceAuth(): Promise<DeviceAuth> {
  return auth().startDeviceAuth();
}

/** device 토큰 1회 폴링. 승인 전이면 pending, 승인되면 토큰 교환·저장 후 complete. */
export async function pollDeviceToken(deviceAuthId: string, userCode: string): Promise<DevicePoll> {
  const result = await auth().pollDeviceToken(deviceAuthId, userCode);
  if (result.status === "complete") clearRevoked(); // 새 세션이 저장됐다
  return result;
}

/** 로그아웃 — 저장된 토큰 삭제. */
export function logout(): void {
  auth().logout();
  clearRevoked();
}

/**
 * UI 표시용 상태(토큰 미노출).
 *
 * revoke 가 확인된 세션은 미로그인으로 보고한다. 파일은 형제 프로세스의 compare-and-swap 을 위해
 * 남기지만, 화면까지 "로그인됨" 이라고 말하면 운영자가 고장을 알아차릴 단서가 없다 — 같은 화면의
 * oauth 선택지는 이미 "불가" 로 회색이 되므로 서로 모순되기까지 한다.
 * (storeExists() 와 마찬가지로 세션이 바뀌었으면 마커를 지우는 부수효과가 있다.)
 */
export function readStoreStatus(): AuthStatus {
  if (sessionRevoked()) return { exists: false };
  return auth().status();
}

/** 로그인 결과. 이전 구현은 토큰까지 돌려줬지만 소비자는 계정·만료만 쓴다. */
export type LoginResult = { exists: true; accountId?: string; expires: number };

/**
 * 로컬 브라우저 OAuth 로그인(PKCE). localhost:1455 콜백으로 code 를 받아 토큰으로 교환·저장한다.
 * CLI(`pnpm openai:login`)에서 호출한다.
 *
 * subauth/login 을 동적 import 하는 이유: 그 엔트리는 node:http 와 node:child_process 를 끌어오는데,
 * 이 모듈은 서버 코드(model-config → openai-oauth)도 함께 import 한다. 정적 import 로 두면 로그인
 * 전용 코드가 서버 번들까지 따라 들어간다.
 */
export async function runBrowserLogin(): Promise<LoginResult> {
  const { loginWithBrowser } = await import("subauth/login");
  const status = await loginWithBrowser({
    store: fileTokenStore(storePath()),
    userAgent: USER_AGENT,
    port: CALLBACK_PORT,
    onVerificationUrl: (url) => {
      console.log("\n브라우저에서 ChatGPT 로그인을 완료하세요:\n" + url + "\n");
    },
  });
  // 로그인이 성공하면 subauth 는 만료를 항상 채운다. 타입상으로는 optional 이므로 여기서 확인해
  // 소비자가 undefined 를 만나지 않게 한다(이전 계약은 만료를 필수로 돌려줬다).
  if (status.expires === undefined) {
    throw new Error("로그인은 됐지만 만료 시각이 없습니다 — 다시 로그인하세요.");
  }
  clearRevoked(); // 새 세션이 저장됐다
  return { exists: true, accountId: status.accountId, expires: status.expires };
}
