import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { authMode } from "@/lib/auth-mode";
import { getTailscaleRequestState } from "@/lib/tailscale-auth";
import type { User } from "@/generated/prisma/client";

/**
 * 현재 사용자 조회 — 앱 전체의 단일 초크포인트.
 * - single: 로그인 없이 부트스트랩된 owner(ADMIN_EMAIL 또는 최초 유저)를 반환.
 * - local/oidc: Auth.js JWT 세션에서 userId를 뽑아 조회(jwt/session 콜백이 실어줌).
 */
async function getSingleOwner(): Promise<User | null> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (email) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u) return u; // 매칭 없으면(오타·미시드) 최초 유저로 폴백 — 리다이렉트 루프 방지
  }
  return prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
}

// React cache로 요청당 1회로 메모이즈 — layout·page·i18n/request.ts가 각각 호출해도 세션/DB 조회는 한 번.
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const mode = authMode();
  if (mode === "single") return getSingleOwner();
  if (mode === "tailscale") {
    const state = await getTailscaleRequestState();
    return state.status === "authenticated" ? state.user : null;
  }
  const session = await auth();
  const uid = session?.user?.id;
  if (uid) return prisma.user.findUnique({ where: { id: uid } });
  // 폴백: 콜백이 id를 못 실은 예외 경로에서도 email로 복구.
  const email = session?.user?.email;
  return email ? prisma.user.findUnique({ where: { email } }) : null;
});

/** 로그인 필수 컨텍스트용. 미인증 시 리다이렉트. 시그니처 불변(호출부 무영향). */
export async function getCurrentUserId(): Promise<string> {
  const user = await getCurrentUser();
  if (user) return user.id;
  if (authMode() === "tailscale") redirect("/claim");
  // loop-free: 비밀번호를 가진 관리자가 아직 없으면 최초 셋업으로, 있으면 로그인으로.
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  redirect(bootstrapped === 0 ? "/setup" : "/login");
}
