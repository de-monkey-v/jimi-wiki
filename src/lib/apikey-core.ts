// 순수 crypto 유틸(서버/CLI 공용). "server-only" 없음 — tsx 스크립트에서도 import 가능.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 32; // 256비트 엔트로피
const TOKEN_PREFIX = "jw";
const PREFIX_DISPLAY_LEN = 12;

export interface GeneratedApiKey {
  token: string; // 전체 시크릿(생성 시 1회만 노출)
  prefix: string; // 비밀 아님 — UI 표시용
  hashedKey: string; // sha256(token) hex — DB 저장(unique)
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(KEY_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}_${secret}`;
  return { token, prefix: token.slice(0, PREFIX_DISPLAY_LEN), hashedKey: hashApiKey(token) };
}

/** `Authorization: Bearer <token>` 파싱. 스킴 대소문자 무시, 실패 시 null. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

/** 같은 길이 hex를 상수 시간 비교. 길이 다르면 즉시 false. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
