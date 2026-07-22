import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/client";

// ---------- 멤버십 ----------
/** email로 멤버 초대. OAuth 전이라 유저가 없으면 생성(find-or-create). */
export async function inviteMember(wikiId: string, email: string, role: Role) {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error("올바른 이메일이 아닙니다");
  const user = await prisma.user.upsert({ where: { email: clean }, update: {}, create: { email: clean } });
  // 기존 멤버를 재초대해 강등하는 경로도 last-owner 불변식을 지켜야 한다(updateMemberRole과 동일).
  const existing = await prisma.membership.findUnique({ where: { wikiId_userId: { wikiId, userId: user.id } } });
  if (existing && existing.role === "owner" && role !== "owner" && (await ownerCount(wikiId)) <= 1) {
    throw new Error("마지막 owner의 역할은 변경할 수 없습니다");
  }
  await prisma.membership.upsert({
    where: { wikiId_userId: { wikiId, userId: user.id } },
    update: { role },
    create: { wikiId, userId: user.id, role },
  });
  return { userId: user.id, email: clean, role };
}

export function listMembers(wikiId: string) {
  return prisma.membership.findMany({
    where: { wikiId },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

function ownerCount(wikiId: string) {
  return prisma.membership.count({ where: { wikiId, role: "owner" } });
}

export async function updateMemberRole(wikiId: string, userId: string, role: Role) {
  const m = await prisma.membership.findUnique({ where: { wikiId_userId: { wikiId, userId } } });
  if (!m) throw new Error("멤버가 아닙니다");
  if (m.role === "owner" && role !== "owner" && (await ownerCount(wikiId)) <= 1) {
    throw new Error("마지막 owner의 역할은 변경할 수 없습니다");
  }
  return prisma.membership.update({ where: { wikiId_userId: { wikiId, userId } }, data: { role } });
}

export async function removeMember(wikiId: string, userId: string) {
  const m = await prisma.membership.findUnique({ where: { wikiId_userId: { wikiId, userId } } });
  if (!m) return;
  if (m.role === "owner" && (await ownerCount(wikiId)) <= 1) {
    throw new Error("마지막 owner는 제거할 수 없습니다");
  }
  await prisma.membership.delete({ where: { wikiId_userId: { wikiId, userId } } });
}

// ---------- 공유 링크 ----------
export async function createShareLink(wikiId: string, role: Role = "viewer", expiresAt?: Date | null) {
  const token = randomBytes(24).toString("base64url");
  return prisma.shareLink.create({ data: { wikiId, token, role, expiresAt: expiresAt ?? null } });
}

export function listShareLinks(wikiId: string) {
  return prisma.shareLink.findMany({ where: { wikiId }, orderBy: { createdAt: "desc" } });
}

export async function revokeShareLink(wikiId: string, id: string) {
  await prisma.shareLink.deleteMany({ where: { id, wikiId } }); // wikiId 조건으로 테넌트 격리
}

/** 공개 읽기 토큰 해석. 만료/부재면 null. */
export async function resolveShareLink(token: string) {
  const link = await prisma.shareLink.findUnique({ where: { token }, include: { wiki: true } });
  if (!link) return null;
  if (link.wiki.trashedAt) return null;
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return null;
  return link;
}
