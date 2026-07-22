import "server-only";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import type { User } from "@/generated/prisma/client";
import { unauthenticatedPath } from "@/lib/auth-mode";

/** 인스턴스 관리자 전용 컨텍스트. 미인증→/login, 비관리자→/wikis. getCurrentUser 위에 얇게 얹는다. */
export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(unauthenticatedPath());
  if (!user.isAdmin) redirect("/wikis");
  return user;
}
