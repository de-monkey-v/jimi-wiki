"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { DEV_SESSION_COOKIE, signSession } from "@/lib/session";

/** 테스트 로그인: 이메일로 계정 find-or-create 후 서명된 쿠키 세션 설정. OAuth 붙이면 이 액션이 대체됨. */
export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("올바른 이메일이 아닙니다");
  await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
  const store = await cookies();
  store.set(DEV_SESSION_COOKIE, signSession(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/wikis");
}

export async function logoutAction() {
  const store = await cookies();
  store.delete(DEV_SESSION_COOKIE);
  redirect("/login");
}
