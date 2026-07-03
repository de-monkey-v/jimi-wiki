import "server-only";
import { prisma } from "@/lib/db";
import { generateApiKey, hashApiKey, parseBearer, safeEqualHex } from "@/lib/apikey-core";
import type { User } from "@/generated/prisma/client";

/**
 * 프로그램적 호출(외부 스킬)용 API 키 인증. 서버 전용.
 * 순수 crypto는 apikey-core.ts(server-only 없음)에 분리 — CLI/스크립트가 재사용.
 * 원문 키는 저장하지 않고 sha256 해시만 저장한다. 키가 256비트 랜덤이라 엔트로피가
 * 보안을 담보하므로 sha256으로 충분하고 매 요청 검증이 빠르다.
 */

/** 사용자에게 새 API 키 발급. 반환된 token은 이 순간에만 존재. */
export async function createApiKey(
  userId: string,
  name: string,
): Promise<{ id: string; name: string; prefix: string; token: string }> {
  const g = generateApiKey();
  const record = await prisma.apiKey.create({
    data: { userId, name: name.trim() || "api-key", hashedKey: g.hashedKey, prefix: g.prefix },
  });
  return { id: record.id, name: record.name, prefix: record.prefix, token: g.token };
}

export function listApiKeys(userId: string) {
  return prisma.apiKey.findMany({
    where: { userId },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeApiKey(userId: string, id: string) {
  await prisma.apiKey.deleteMany({ where: { id, userId } }); // userId 조건으로 소유자 격리
}

/**
 * Bearer 토큰으로 사용자 인증: Authorization 파싱 → sha256 unique 조회 →
 * timingSafeEqual 재확인 → lastUsedAt fire-and-forget 갱신. 실패 시 null.
 */
export async function getApiUser(req: Request): Promise<User | null> {
  const token = parseBearer(req.headers.get("authorization"));
  if (!token) return null;

  const hashed = hashApiKey(token);
  const key = await prisma.apiKey.findUnique({ where: { hashedKey: hashed }, include: { user: true } });
  if (!key) return null;
  if (!safeEqualHex(hashed, key.hashedKey)) return null;

  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return key.user;
}
