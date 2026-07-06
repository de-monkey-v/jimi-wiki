import { prisma } from "@/lib/db";
import InviteForm from "./InviteForm";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await prisma.invite.findUnique({ where: { token } });
  const invalid = !invite || !!invite.usedAt || (invite.expiresAt != null && invite.expiresAt < new Date());

  if (invalid) {
    return (
      <main className="mx-auto max-w-sm px-6 py-20">
        <h1 className="text-xl font-bold">유효하지 않거나 만료된 초대입니다</h1>
        <p className="text-sm text-gray-500 mt-2">관리자에게 새 초대 링크를 요청하세요.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-6">초대 수락 · 계정 만들기</h1>
      <InviteForm token={token} email={invite!.email ?? ""} />
    </main>
  );
}
