import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { User } from "@/generated/prisma/client";

/**
 * 세션 (OAuth 전 테스트용 쿠키 세션).
 * 쿠키 `dev_user`에 `email.<HMAC서명>`을 담는다 — 서명 검증 없이는 위조 불가.
 * (평문 이메일만 담으면 curl로 임의 계정 도용 가능하므로 AUTH_SECRET으로 서명한다.)
 * OAuth를 붙이면 getCurrentUser 내부만 Auth.js 세션 조회로 교체하면 된다.
 */
export const DEV_SESSION_COOKIE = "dev_user";
const SECRET = process.env.AUTH_SECRET ?? "dev-insecure-secret-change-me";

function hmac(email: string): string {
  return createHmac("sha256", SECRET).update(email).digest("hex");
}

/** 쿠키에 저장할 서명된 값 생성 (login에서 사용). */
export function signSession(email: string): string {
  return `${email}.${hmac(email)}`;
}

/** 서명 검증 후 이메일 반환. 위조/변조면 null. (sig는 hex라 이메일의 '.'과 구분됨 — 마지막 '.'이 구분자) */
function verifySession(value: string | undefined): string | null {
  if (!value) return null;
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const email = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = hmac(email);
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === b.length && timingSafeEqual(a, b)) return email;
  } catch {
    /* malformed */
  }
  return null;
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const email = verifySession(store.get(DEV_SESSION_COOKIE)?.value);
  if (!email) return null;
  return prisma.user.findUnique({ where: { email } });
}

/** 로그인 필수 컨텍스트용. 미로그인 시 /login으로 리다이렉트. */
export async function getCurrentUserId(): Promise<string> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user.id;
}
