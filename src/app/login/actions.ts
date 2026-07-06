"use server";
import { AuthError } from "next-auth";
import { prisma } from "@/lib/db";
import { signIn, signOut } from "@/auth";
import { hashPassword } from "@/lib/password";
import { findValidInvite } from "@/lib/invite";
import type { ActionState } from "./types";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 이메일+비밀번호 로그인. 성공 시 signIn이 NEXT_REDIRECT를 throw하므로 AuthError만 잡고 나머지는 rethrow. */
export async function credentialsLoginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "이메일과 비밀번호를 입력하세요" };
  try {
    await signIn("credentials", { email, password, redirectTo: "/wikis" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) return { error: "이메일 또는 비밀번호가 올바르지 않습니다" };
    throw e;
  }
}

/** 초대 토큰으로 계정 생성(공개가입 대체). 초대 소진은 트랜잭션 내에서 재확인해 1회성 보장. */
export async function registerWithInviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const token = String(fd.get("token") ?? "");
  const password = String(fd.get("password") ?? "");
  let email = String(fd.get("email") ?? "").trim().toLowerCase();

  const invite = await findValidInvite(token);
  if (!invite) return { error: "유효하지 않거나 만료된 초대입니다" };
  if (invite.email) {
    if (email && email !== invite.email.toLowerCase()) return { error: "초대된 이메일과 일치하지 않습니다" };
    email = invite.email.toLowerCase();
  }
  if (!EMAIL_RE.test(email)) return { error: "올바른 이메일이 아닙니다" };
  if (password.length < 8) return { error: "비밀번호는 8자 이상이어야 합니다" };
  if (await prisma.user.findUnique({ where: { email } })) return { error: "이미 가입된 이메일입니다. 로그인하세요." };

  const passwordHash = await hashPassword(password);
  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.invite.findUnique({ where: { token } });
      if (!fresh || fresh.usedAt) throw new Error("invite-consumed");
      const user = await tx.user.create({ data: { email, passwordHash, name: email.split("@")[0] } });
      if (fresh.wikiId) await tx.membership.create({ data: { wikiId: fresh.wikiId, userId: user.id, role: fresh.role } });
      await tx.invite.update({ where: { token }, data: { usedAt: new Date(), usedByUserId: user.id } });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "invite-consumed") return { error: "이미 사용된 초대입니다" };
    throw e;
  }

  try {
    await signIn("credentials", { email, password, redirectTo: "/wikis" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) return { error: "가입 완료. 로그인 페이지에서 로그인하세요." };
    throw e;
  }
}

/** 시그니처 유지: WikiToc/Sidebar/wikis 의 <form action={logoutAction}> 호출부 불변. */
export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
