import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { authMode } from "@/lib/auth-mode";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Login() {
  if (authMode() === "single") redirect("/wikis"); // 로그인 없음
  const bootstrapped = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (bootstrapped === 0) redirect("/setup"); // 최초 관리자 미생성 → 셋업으로

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-2">jimi-wiki 로그인</h1>
      <p className="text-sm text-gray-500 mb-6">이메일과 비밀번호로 로그인하세요.</p>
      <LoginForm />
    </main>
  );
}
