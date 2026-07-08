"use server";
import { AuthError } from "next-auth";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { signIn } from "@/auth";
import { hashPassword } from "@/lib/password";
import { authMode } from "@/lib/auth-mode";
import type { ActionState } from "@/app/login/types";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** first-run 최초 관리자 생성. advisory lock + 트랜잭션 내 재확인으로 이중 생성 레이스 차단. */
export async function setupAdminAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("SetupActions");
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const name = String(fd.get("name") ?? "").trim() || email.split("@")[0];
  if (!EMAIL_RE.test(email)) return { error: t("invalidEmail") };
  if (password.length < 8) return { error: t("passwordTooShort") };

  const passwordHash = await hashPassword(password);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(918273645)`;
      const existing = await tx.user.count({ where: { passwordHash: { not: null } } });
      if (existing > 0) throw new Error("already-initialized");
      await tx.user.create({ data: { email, passwordHash, name, isAdmin: true, emailVerified: new Date() } });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "already-initialized") return { error: t("alreadyInitialized") };
    throw e;
  }

  if (authMode() === "single") redirect("/wikis"); // single: 로그인 없이 owner로 진입
  try {
    await signIn("credentials", { email, password, redirectTo: "/wikis" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) return { error: t("adminCreatedLoginPrompt") };
    throw e;
  }
}
