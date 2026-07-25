import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { authMode } from "@/lib/auth-mode";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Login() {
  const t = await getTranslations("LoginPage");
  const mode = authMode();
  if (mode === "single") redirect("/wikis"); // 로그인 없음
  if (mode === "tailscale") redirect("/claim");
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (bootstrapped === 0) redirect("/setup"); // 최초 관리자 미생성 → 셋업으로

  return (
    <main className="mx-auto compact-measure px-4 py-16 sm:px-6 sm:py-20">
      <div className="surface-panel mx-auto max-w-sm p-6 sm:p-8">
      <header className="page-header">
        <p className="page-kicker">jimi-wiki</p>
        <h1 className="page-title">{t("title")}</h1>
        <p className="page-description">{t("subtitle")}</p>
      </header>
      <LoginForm />
      </div>
    </main>
  );
}
