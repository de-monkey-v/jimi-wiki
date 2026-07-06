"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { hashPassword } from "@/lib/password";
import { createInvite, revokeInvite } from "@/lib/invite";
import type { Role } from "@/generated/prisma/client";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 관리자가 유저 계정을 직접 생성(임시 비밀번호 지정). */
export async function createUserAction(fd: FormData) {
  await requireAdmin();
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const name = String(fd.get("name") ?? "").trim() || null;
  const password = String(fd.get("password") ?? "");
  if (!EMAIL_RE.test(email)) throw new Error("올바른 이메일이 아닙니다");
  if (password.length < 8) throw new Error("비밀번호는 8자 이상이어야 합니다");
  if (await prisma.user.findUnique({ where: { email } })) throw new Error("이미 가입된 이메일입니다");
  await prisma.user.create({ data: { email, name, passwordHash: await hashPassword(password) } });
  revalidatePath("/admin/users");
}

/** 유저 비밀번호 재설정(잠금 복구·초기 비밀번호 전달용). */
export async function resetPasswordAction(fd: FormData) {
  await requireAdmin();
  const userId = String(fd.get("userId") ?? "");
  const password = String(fd.get("password") ?? "");
  if (password.length < 8) throw new Error("비밀번호는 8자 이상이어야 합니다");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
  revalidatePath("/admin/users");
}

/** 인스턴스 관리자 지정/해제. 자기 자신 해제는 금지(락아웃 방지). */
export async function setUserAdminAction(fd: FormData) {
  const admin = await requireAdmin();
  const userId = String(fd.get("userId") ?? "");
  const makeAdmin = fd.get("admin") === "true";
  if (userId === admin.id && !makeAdmin) throw new Error("자기 자신의 관리자 권한은 해제할 수 없습니다");
  await prisma.user.update({ where: { id: userId }, data: { isAdmin: makeAdmin } });
  revalidatePath("/admin/users");
}

export async function createInviteAction(fd: FormData) {
  const admin = await requireAdmin();
  const email = String(fd.get("email") ?? "").trim().toLowerCase() || null;
  const wikiId = String(fd.get("wikiId") ?? "") || null;
  const role = (String(fd.get("role") ?? "viewer") as Role);
  const ttlDays = Number(fd.get("ttlDays") ?? "7") || 7;
  await createInvite(admin.id, { email, wikiId, role, ttlDays });
  revalidatePath("/admin/users");
}

export async function revokeInviteAction(fd: FormData) {
  await requireAdmin();
  await revokeInvite(String(fd.get("inviteId") ?? ""));
  revalidatePath("/admin/users");
}
