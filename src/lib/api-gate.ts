import "server-only";
import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/apikey";
import { getWikiForUser } from "@/lib/wiki";
import type { User, Role } from "@/generated/prisma/client";

type WikiForUser = NonNullable<Awaited<ReturnType<typeof getWikiForUser>>>;

export type Gate = { ok: true; user: User; wiki: WikiForUser } | { ok: false; res: NextResponse };

// 역할 위계: viewer < editor < owner
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * 콘텐츠 API 공통 게이트: Bearer 토큰 인증 → 위키 멤버십 확인 → 역할(minRole) 검사.
 * :id는 wiki slug(getWikiForUser가 slug 기반). Next가 경로 파라미터를 이미 디코드.
 * 쓰기 라우트는 { minRole: "editor" }를 넘긴다(읽기는 기본 viewer).
 */
export async function apiWikiGate(req: Request, slug: string, opts?: { minRole?: Role }): Promise<Gate> {
  const user = await getApiUser(req);
  if (!user) {
    return {
      ok: false,
      res: NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
    };
  }
  const wiki = await getWikiForUser(user.id, slug);
  if (!wiki) {
    return { ok: false, res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  if (opts?.minRole && !hasRole(wiki.role, opts.minRole)) {
    return { ok: false, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, user, wiki };
}
