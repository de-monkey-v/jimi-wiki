export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
export const TAILSCALE_PROVIDER = "tailscale";
// setup/claim/reset/recovery/key rotation의 auth 전환을 직렬화하는 고정 PostgreSQL advisory lock id.
export const AUTH_TRANSITION_LOCK_ID = 5_783_424_901;

export type TailscaleIdentity =
  | { status: "allowed"; login: string }
  | { status: "invalid-config" | "missing-header" | "forbidden-login" };

type HeaderReader = { get(name: string): string | null };

/**
 * Serve identity는 정확한 allowlist 문자열만 인정한다.
 * trim/lowercase 정규화를 안 하므로 공백·대소문자·중복 헤더(쉼표 병합)는 모두 거부된다.
 */
export function resolveTailscaleIdentity(
  requestHeaders: HeaderReader,
  allowedLogin: string | undefined,
): TailscaleIdentity {
  if (!allowedLogin || allowedLogin !== allowedLogin.trim() || /[\s,\u0000-\u001f\u007f]/u.test(allowedLogin)) {
    return { status: "invalid-config" };
  }
  const received = requestHeaders.get(TAILSCALE_LOGIN_HEADER);
  if (received === null || received === "") return { status: "missing-header" };
  if (received !== allowedLogin) return { status: "forbidden-login" };
  return { status: "allowed", login: received };
}

export function tailscaleConfigProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const login = env.TAILSCALE_ALLOWED_LOGIN;
  if (resolveTailscaleIdentity({ get: () => login ?? null }, login).status !== "allowed") {
    problems.push("TAILSCALE_ALLOWED_LOGIN");
  }
  try {
    const url = new URL(env.APP_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password) problems.push("APP_URL(https)");
  } catch {
    problems.push("APP_URL(https)");
  }
  return problems;
}
