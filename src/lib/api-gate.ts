import "server-only";
import { NextResponse } from "next/server";
import { getApiAuth } from "@/lib/apikey";
import { parseBearer } from "@/lib/apikey-core";
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
 * 비용 발생 없는 세션 전용 위키 게이트.
 * revision 조회·복원, draft 승인 같이 "사람 세션" 자체가 인가 경계인 동작에 쓴다.
 * 생성형 요청용 레이트리밋·일일 토큰 쿼터를 소비하지 않는다.
 */
export async function sessionWikiGate(slug: string, opts?: { minRole?: Role }): Promise<Gate> {
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
  return { ok: true, user, wiki };
}

/**
 * Authorization: Bearer 헤더 유무 — 요청이 API 키 경로인지 세션 경로인지 가른다.
 * 판정 규약은 apikey-core 의 parseBearer 와 반드시 같아야 한다(탭 구분·선행 공백 등에서
 * 갈리면 유효 키인데 세션 경로로 빠져 401 이 된다). 그래서 토큰 파싱 결과로 직접 판정한다.
 */
export function hasBearerAuth(req: Request): boolean {
  return parseBearer(req.headers.get("authorization")) !== null;
}

/**
 * Bearer 키와 쿠키 세션을 모두 받는 게이트 — 외부 에이전트(MCP)와 웹 UI가 같은 라우트를 공유할 때 쓴다.
 * Bearer 가 있으면 apiWikiGate(키 스코프·상한역할·레이트리밋), 없으면 sessionWikiGate.
 * ⚠️ 생성형 LLM 을 유발하는 라우트에서 쓸 때는 호출부가 비용 제어를 덧붙여야 한다
 *    (API 키 경로: checkGenerativeQuotaResponse, 세션 경로: sessionOnlyGate).
 */
export async function apiOrSessionWikiGate(req: Request, slug: string, opts?: { minRole?: Role }): Promise<Gate> {
  return hasBearerAuth(req) ? apiWikiGate(req, slug, opts) : sessionWikiGate(slug, opts);
}

/**
 * 생성형 비용의 일일 상한 검사 — 초과면 429 응답, 통과면 null.
 * apiWikiGate 가 이미 레이트리밋을 소비한 API 키 경로에서, 레이트리밋을 이중 소비하지 않고
 * 쿼터만 덧붙이기 위한 조각(sessionOnlyGate 의 쿼터 부분과 동일 규약).
 */
export async function checkGenerativeQuotaResponse(userId: string): Promise<NextResponse | null> {
  const q = await checkDailyQuota(userId);
  if (q.ok) return null;
  return NextResponse.json({ error: "daily_quota_exceeded", used: q.used, limit: q.limit }, { status: 429 });
}

/**
 * 생성형 LLM 소비 라우트 전용 게이트 — API 키로는 인증 불가, 세션(사람 UI)만 허용.
 * "인증 경계 = 비용 경계": 생성형 Gemini(generateText/streamText/generateWithTools)를 돌리는
 * 엔드포인트(query/ingest/lint-deep 등)는 쿠키 세션으로만 연다. 임베딩(search/reindex 등)은
 * agent primitive·저비용이라 apiWikiGate(API 키)로 열되 레이트리밋으로 통제한다.
 * sessionWikiGate에 생성형 비용 제어를 덧붙인다.
 * 미인증 401, 위키 없음/무권한 404, minRole 미달 403, 레이트리밋·쿼터 초과 429.
 */
export async function sessionOnlyGate(slug: string, opts?: { minRole?: Role }): Promise<Gate> {
  const gate = await sessionWikiGate(slug, opts);
  if (!gate.ok) return gate;
  const { user } = gate;
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
  return gate;
}
