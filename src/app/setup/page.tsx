import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import SetupForm from "./SetupForm";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // 비밀번호를 가진 관리자가 이미 있으면 셋업 종료(모드 무관). loop-free 게이트.
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (bootstrapped > 0) redirect("/login");

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-2">최초 관리자 설정</h1>
      <p className="text-sm text-gray-500 mb-6">이 인스턴스의 첫 관리자 계정을 만듭니다.</p>
      <SetupForm />
    </main>
  );
}
