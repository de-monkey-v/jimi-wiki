import "server-only";
import { NextResponse } from "next/server";
import { getApiAuth } from "@/lib/apikey";
import { checkRateLimit } from "@/lib/ratelimit";
import { checkDailyQuota } from "@/lib/usage";
import { getCurrentUser } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import type { User, Role } from "@/generated/prisma/client";

type WikiForUser = NonNullable<Awaited<ReturnType<typeof getWikiForUser>>>;

export type Gate = { ok: true; user: User; wiki: WikiForUser } | { ok: false; res: NextResponse };

// 역할 위계: viewer < editor < owner
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** 두 역할 중 더 낮은(권한 적은) 쪽. cap이 null/undefined면 base 그대로 — 키 상한(maxRole) 적용용. */
export function minRole(base: Role, cap: Role | null | undefined): Role {
  if (cap == null) return base;
  return ROLE_RANK[base] <= ROLE_RANK[cap] ? base : cap;
}

/**
 * 콘텐츠 API 공통 게이트: Bearer 토큰 인증 → 위키 멤버십 확인 → 역할(minRole) 검사.
 * :id는 wiki slug(getWikiForUser가 slug 기반). Next가 경로 파라미터를 이미 디코드.
 * 쓰기 라우트는 { minRole: "editor" }를 넘긴다(읽기는 기본 viewer).
 */
export async function apiWikiGate(req: Request, slug: string, opts?: { minRole?: Role }): Promise<Gate> {
  const auth = await getApiAuth(req);
  if (!auth) {
    return {
      ok: false,
      res: NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
    };
  }
  const { user, key } = auth;
  const wiki = await getWikiForUser(user.id, slug);
  if (!wiki) {
    return { ok: false, res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  // 키가 특정 위키로 스코프되어 있으면 그 위키에서만 통과(다른 위키는 존재를 숨겨 404)
  if (key.wikiId && key.wikiId !== wiki.id) {
    return { ok: false, res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  // 유효역할 = min(멤버십역할, key.maxRole ?? 멤버십역할). 다운스트림 hasRole 검사가 상한을 존중하도록 wiki.role에 반영.
  const effectiveRole = minRole(wiki.role, key.maxRole);
  if (opts?.minRole && !hasRole(effectiveRole, opts.minRole)) {
    return { ok: false, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  // 레이트리밋은 인가(멤버십·스코프·역할) 통과 후 소비 — 권한 없는 probing이 정당 요청의 버킷을 깎지 않도록.
  const rl = checkRateLimit(key.id ?? user.id);
  if (!rl.ok) {
    return {
      ok: false,
      res: NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }),
    };
  }
  return { ok: true, user, wiki: { ...wiki, role: effectiveRole } };
}

/**
 * 생성형 LLM 소비 라우트 전용 게이트 — API 키로는 인증 불가, 세션(사람 UI)만 허용.
 * "인증 경계 = 비용 경계": 생성형 Gemini(generateText/streamText/generateWithTools)를 돌리는
 * 엔드포인트(query/ingest/lint-deep 등)는 쿠키 세션으로만 연다. 임베딩(search/reindex 등)은
 * agent primitive·저비용이라 apiWikiGate(API 키)로 열되 레이트리밋으로 통제한다.
 * apiWikiGate와 동일한 Gate 반환 형태이되 인증만 getCurrentUser(쿠키)로 대체.
 * 미인증 401, 위키 없음/무권한 404, minRole 미달 403, 레이트리밋 초과 429.
 */
export async function sessionOnlyGate(slug: string, opts?: { minRole?: Role }): Promise<Gate> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const wiki = await getWikiForUser(user.id, slug);
  if (!wiki) {
    return { ok: false, res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  if (opts?.minRole && !hasRole(wiki.role, opts.minRole)) {
    return { ok: false, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  // 생성형 LLM은 비싸다 — 세션(유저) 단위 레이트리밋으로 남용·세션 탈취 시 비용 폭주를 막는다.
  const rl = checkRateLimit(`session:${user.id}`);
  if (!rl.ok) {
    return {
      ok: false,
      res: NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }),
    };
  }
  // 일일 생성형 토큰 쿼터 — 세션 경로의 누적 비용 상한(레이트리밋이 못 막는 저속·지속 소비를 통제).
  const q = await checkDailyQuota(user.id);
  if (!q.ok) {
    return {
      ok: false,
      res: NextResponse.json({ error: "daily_quota_exceeded", used: q.used, limit: q.limit }, { status: 429 }),
    };
  }
  return { ok: true, user, wiki };
}
