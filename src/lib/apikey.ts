import "server-only";
import { prisma } from "@/lib/db";
import { generateApiKey, hashApiKey, parseBearer, safeEqualHex } from "@/lib/apikey-core";
import type { User, Role } from "@/generated/prisma/client";

/**
 * 프로그램적 호출(외부 스킬)용 API 키 인증. 서버 전용.
 * 순수 crypto는 apikey-core.ts(server-only 없음)에 분리 — CLI/스크립트가 재사용.
 * 원문 키는 저장하지 않고 sha256 해시만 저장한다. 키가 256비트 랜덤이라 엔트로피가
 * 보안을 담보하므로 sha256으로 충분하고 매 요청 검증이 빠르다.
 */

// 유저당 활성(미폐기) 키 상한 — 무한 발급으로 인한 남용/키 관리 부담 방지.
export const MAX_ACTIVE_KEYS = 20;

/**
 * 사용자에게 새 API 키 발급. 반환된 token은 이 순간에만 존재.
 * opts.wikiId: 스코프 위키(null=전체=레거시), opts.maxRole: 상한 역할(null=다운그레이드 없음),
 * opts.expiresAt: 만료 시각(null=무만료). 기본값은 "기존 키 동작 불변".
 * 활성 키가 MAX_ACTIVE_KEYS를 넘으면 throw.
 */
export async function createApiKey(
  userId: string,
  name: string,
  opts?: { wikiId?: string | null; maxRole?: Role | null; expiresAt?: Date | null },
): Promise<{ id: string; name: string; prefix: string; token: string }> {
  const active = await prisma.apiKey.count({ where: { userId, revokedAt: null } });
  if (active >= MAX_ACTIVE_KEYS) {
    throw new Error(`활성 API 키가 너무 많습니다(최대 ${MAX_ACTIVE_KEYS}개). 기존 키를 폐기한 뒤 다시 시도하세요.`);
  }
  const g = generateApiKey();
  const record = await prisma.apiKey.create({
    data: {
      userId,
      name: name.trim() || "api-key",
      hashedKey: g.hashedKey,
      prefix: g.prefix,
      wikiId: opts?.wikiId ?? null,
      maxRole: opts?.maxRole ?? null,
      expiresAt: opts?.expiresAt ?? null,
    },
  });
  return { id: record.id, name: record.name, prefix: record.prefix, token: g.token };
}

/** 활성(미폐기) 키만 나열. expired는 여기(데이터 계층)서 판정 — 렌더 중 Date.now() 회피. */
export async function listApiKeys(userId: string) {
  const rows = await prisma.apiKey.findMany({
    where: { userId, revokedAt: null },
    select: {
      id: true,
      name: true,
      prefix: true,
      lastUsedAt: true,
      createdAt: true,
      maxRole: true,
      expiresAt: true,
      wiki: { select: { slug: true, title: true } }, // 스코프 위키(null=전체) 표시용
    },
    orderBy: { createdAt: "desc" },
  });
  const now = Date.now();
  return rows.map((r) => ({ ...r, expired: r.expiresAt ? r.expiresAt.getTime() <= now : false }));
}

/** soft-revoke: 하드삭제 대신 revokedAt을 채운다(감사·usage 추적 보존). 이미 폐기된 건 no-op. */
export async function revokeApiKey(userId: string, id: string) {
  await prisma.apiKey.updateMany({
    where: { id, userId, revokedAt: null }, // userId 조건으로 소유자 격리
    data: { revokedAt: new Date() },
  });
}

/** 인증된 키의 메타(스코프·상한 역할). 게이트가 위키 스코프/유효역할 계산에 사용. */
export type ApiKeyMeta = { id: string; wikiId: string | null; maxRole: Role | null };
export type ApiAuth = { user: User; key: ApiKeyMeta };

/**
 * Bearer 토큰으로 인증하고 사용자 + 키 메타를 반환:
 * Authorization 파싱 → sha256 unique 조회 → timingSafeEqual 재확인 →
 * lastUsedAt fire-and-forget 갱신. 실패 시 null.
 */
export async function getApiAuth(req: Request): Promise<ApiAuth | null> {
  const token = parseBearer(req.headers.get("authorization"));
  if (!token) return null;

  const hashed = hashApiKey(token);
  const key = await prisma.apiKey.findUnique({ where: { hashedKey: hashed }, include: { user: true } });
  if (!key) return null;
  if (!safeEqualHex(hashed, key.hashedKey)) return null;
  // 수명주기 검사: 폐기(soft-revoke)되었거나 만료된 키는 인증 실패
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { user: key.user, key: { id: key.id, wikiId: key.wikiId, maxRole: key.maxRole } };
}

/** 위 getApiAuth의 사용자만 필요한 호출부용 얇은 래퍼(레거시 시그니처 유지). */
export async function getApiUser(req: Request): Promise<User | null> {
  const auth = await getApiAuth(req);
  return auth?.user ?? null;
}
