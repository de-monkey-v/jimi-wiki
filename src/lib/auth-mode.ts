/**
 * 인증 모드 — self-host 설치자가 env AUTH_MODE로 선택하는 단일 소스.
 * auth.ts · session.ts · login/setup 페이지가 모두 이 함수를 import 한다(중복 정의 금지).
 *
 * - single: 로그인 없음. 암묵적 owner 1명(순수 개인용, localhost 전용 권장).
 * - local    : 이메일+비밀번호(argon2). 공개가입 off, 관리자 생성/초대. (기본)
 * - tailscale: Tailscale Serve가 전달한 identity header로 기존 User Account를 매핑.
 * - oidc     : 외부 OIDC provider 1개(phase-2, 현재 미배선).
 */
export type AuthMode = "single" | "local" | "tailscale" | "oidc";

const AUTH_MODES = new Set<AuthMode>(["single", "local", "tailscale", "oidc"]);

/** 명시된 오타를 local로 조용히 강등하지 않는 fail-closed parser. */
export function parseAuthMode(raw: string | undefined): AuthMode {
  if (raw === undefined) return "local";
  const mode = raw.trim().toLowerCase();
  if (AUTH_MODES.has(mode as AuthMode)) return mode as AuthMode;
  throw new Error(`Unsupported AUTH_MODE: ${raw}`);
}

export function authMode(): AuthMode {
  return parseAuthMode(process.env.AUTH_MODE);
}

export function unauthenticatedPath(): "/claim" | "/login" {
  return authMode() === "tailscale" ? "/claim" : "/login";
}
