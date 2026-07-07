import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import type { User } from "@/generated/prisma/client";

/**
 * API 라우트용 인스턴스 관리자 게이트(세션 전용). api-gate.ts 의 위키 스코프 게이트와 달리
 * 전역 admin(User.isAdmin) 만 통과시킨다. 반환: { ok, user } | { ok:false, res }.
 */
export async function requireAdminApi(): Promise<{ ok: true; user: User } | { ok: false; res: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!user.isAdmin) return { ok: false, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true, user };
}
