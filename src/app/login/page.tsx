import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { authMode } from "@/lib/auth-mode";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Login() {
  const t = await getTranslations("LoginPage");
  if (authMode() === "single") redirect("/wikis"); // 로그인 없음
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (bootstrapped === 0) redirect("/setup"); // 최초 관리자 미생성 → 셋업으로

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-2">{t("title")}</h1>
      <p className="text-sm text-gray-500 mb-6">{t("subtitle")}</p>
      <LoginForm />
    </main>
  );
}
