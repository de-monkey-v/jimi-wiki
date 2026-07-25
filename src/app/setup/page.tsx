import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import SetupForm from "./SetupForm";
import { authMode } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const t = await getTranslations("SetupPage");
  if (authMode() === "tailscale") redirect("/claim");
  // 비밀번호를 가진 관리자가 이미 있으면 셋업 종료(모드 무관). loop-free 게이트.
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (bootstrapped > 0) redirect("/login");

  return (
    <main className="mx-auto compact-measure px-4 py-16 sm:px-6 sm:py-20">
      <div className="surface-panel mx-auto max-w-sm p-6 sm:p-8">
      <header className="page-header">
        <p className="page-kicker">jimi-wiki</p>
        <h1 className="page-title">{t("title")}</h1>
        <p className="page-description">{t("subtitle")}</p>
      </header>
      <SetupForm />
      </div>
    </main>
  );
}
