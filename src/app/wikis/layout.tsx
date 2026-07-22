import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { unauthenticatedPath } from "@/lib/auth-mode";

// 전역 셸: 인증 가드만. 위키 안(/wikis/[slug]/*)에서는 [slug]/layout이 책 목차 사이드바를 그린다.
export default async function WikisLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect(unauthenticatedPath());
  return <>{children}</>;
}
