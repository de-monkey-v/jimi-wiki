import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import SetupForm from "./SetupForm";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const t = await getTranslations("SetupPage");
  // 비밀번호를 가진 관리자가 이미 있으면 셋업 종료(모드 무관). loop-free 게이트.
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (bootstrapped > 0) redirect("/login");

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-2">{t("title")}</h1>
      <p className="text-sm text-gray-500 mb-6">{t("subtitle")}</p>
      <SetupForm />
    </main>
  );
}
