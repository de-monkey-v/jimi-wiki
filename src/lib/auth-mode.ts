/**
 * 인증 모드 — self-host 설치자가 env AUTH_MODE로 선택하는 단일 소스.
 * auth.ts · session.ts · login/setup 페이지가 모두 이 함수를 import 한다(중복 정의 금지).
 *
 * - single: 로그인 없음. 암묵적 owner 1명(순수 개인용, localhost 전용 권장).
 * - local : 이메일+비밀번호(argon2). 공개가입 off, 관리자 생성/초대. (기본)
 * - oidc  : 외부 OIDC provider 1개(phase-2, 현재 미배선).
 */
export type AuthMode = "single" | "local" | "oidc";

export function authMode(): AuthMode {
  const m = (process.env.AUTH_MODE ?? "local").trim().toLowerCase();
  return m === "single" || m === "oidc" ? m : "local";
}
