import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/client";

/** 192비트 URL-safe 초대 토큰. */
export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function createInvite(
  createdById: string,
  opts?: { email?: string | null; wikiId?: string | null; role?: Role; ttlDays?: number },
) {
  const expiresAt = opts?.ttlDays ? new Date(Date.now() + opts.ttlDays * 86_400_000) : null;
  return prisma.invite.create({
    data: {
      token: newInviteToken(),
      email: opts?.email?.trim().toLowerCase() || null,
      wikiId: opts?.wikiId || null,
      role: opts?.role ?? "viewer",
      expiresAt,
      createdById,
    },
  });
}

/** 미사용 초대 목록(관리 화면). */
export function listInvites() {
  return prisma.invite.findMany({
    where: { usedAt: null },
    orderBy: { createdAt: "desc" },
    include: { wiki: { select: { slug: true, title: true } } },
  });
}

export async function revokeInvite(id: string) {
  await prisma.invite.delete({ where: { id } });
}

/** 가입 흐름에서 소비: 유효 초대 조회. 만료/사용됨이면 null. */
export async function findValidInvite(token: string) {
  const inv = await prisma.invite.findUnique({ where: { token }, include: { wiki: { select: { trashedAt: true } } } });
  if (!inv || inv.usedAt) return null;
  if (inv.expiresAt && inv.expiresAt < new Date()) return null;
  if (inv.wiki?.trashedAt) return null;
  return inv;
}
