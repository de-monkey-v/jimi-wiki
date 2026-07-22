"use server";
import { AuthError } from "next-auth";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { signIn, signOut } from "@/auth";
import { hashPassword } from "@/lib/password";
import { findValidInvite } from "@/lib/invite";
import type { ActionState } from "./types";
import { authMode } from "@/lib/auth-mode";
import { redirect } from "next/navigation";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 이메일+비밀번호 로그인. 성공 시 signIn이 NEXT_REDIRECT를 throw하므로 AuthError만 잡고 나머지는 rethrow. */
export async function credentialsLoginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  if (authMode() === "tailscale") redirect("/claim");
  const t = await getTranslations("LoginActions");
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: t("emptyCredentials") };
  try {
    await signIn("credentials", { email, password, redirectTo: "/wikis" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) return { error: t("invalidCredentials") };
    throw e;
  }
}

/** 초대 토큰으로 계정 생성(공개가입 대체). 초대 소진은 트랜잭션 내에서 재확인해 1회성 보장. */
export async function registerWithInviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  if (authMode() === "tailscale") redirect("/claim");
  const t = await getTranslations("LoginActions");
  const token = String(fd.get("token") ?? "");
  const password = String(fd.get("password") ?? "");
  let email = String(fd.get("email") ?? "").trim().toLowerCase();

  const invite = await findValidInvite(token);
  if (!invite) return { error: t("invalidOrExpiredInvite") };
  if (invite.email) {
    if (email && email !== invite.email.toLowerCase()) return { error: t("emailMismatch") };
    email = invite.email.toLowerCase();
  }
  if (!EMAIL_RE.test(email)) return { error: t("invalidEmail") };
  if (password.length < 8) return { error: t("passwordTooShort") };
  if (await prisma.user.findUnique({ where: { email } })) return { error: t("alreadyRegistered") };

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
    if (e instanceof Error && e.message === "invite-consumed") return { error: t("inviteConsumed") };
    throw e;
  }

  try {
    await signIn("credentials", { email, password, redirectTo: "/wikis" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) return { error: t("registeredLoginPrompt") };
    throw e;
  }
}

/** 시그니처 유지: WikiToc/Sidebar/wikis 의 <form action={logoutAction}> 호출부 불변. */
export async function logoutAction() {
  if (authMode() === "tailscale") redirect("/wikis");
  await signOut({ redirectTo: "/login" });
}
