import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { listInvites } from "@/lib/invite";
import {
  createUserAction,
  resetPasswordAction,
  setUserAdminAction,
  createInviteAction,
  revokeInviteAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminUsers() {
  await requireAdmin();
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  const [users, invites] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, isAdmin: true, passwordHash: true },
    }),
    listInvites(),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 space-y-10">
      <h1 className="text-2xl font-bold">유저 관리</h1>

      <section className="space-y-2">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 border rounded px-3 py-2">
            <div className="flex-1 min-w-40">
              <span className="font-medium">{u.email}</span>
              {u.isAdmin && <span className="ml-2 text-xs text-emerald-600">admin</span>}
              {!u.passwordHash && <span className="ml-2 text-xs text-amber-600">비번 미설정</span>}
            </div>
            <form action={setUserAdminAction}>
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="admin" value={String(!u.isAdmin)} />
              <button className="text-xs underline">{u.isAdmin ? "관리자 해제" : "관리자 지정"}</button>
            </form>
            <form action={resetPasswordAction} className="flex items-center gap-1">
              <input type="hidden" name="userId" value={u.id} />
              <input name="password" type="password" required minLength={8} placeholder="새 비번" className="border rounded px-2 py-1 text-xs w-28" />
              <button className="text-xs underline">재설정</button>
            </form>
          </div>
        ))}
      </section>

      <form action={createUserAction} className="border-t pt-6 grid gap-2">
        <h2 className="font-semibold">유저 생성</h2>
        <input name="email" type="email" required placeholder="email" className="border rounded px-3 py-2" />
        <input name="name" placeholder="이름(선택)" className="border rounded px-3 py-2" />
        <input name="password" type="password" required minLength={8} placeholder="임시 비밀번호(8자+)" className="border rounded px-3 py-2" />
        <button className="bg-stone-900 text-white rounded px-4 py-2 w-fit">생성</button>
      </form>

      <form action={createInviteAction} className="border-t pt-6 grid gap-2">
        <h2 className="font-semibold">초대 링크 발급</h2>
        <input name="email" type="email" placeholder="대상 이메일(선택)" className="border rounded px-3 py-2" />
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">유효기간(일)</label>
          <input name="ttlDays" type="number" defaultValue={7} className="border rounded px-3 py-2 w-24" />
        </div>
        <button className="bg-stone-900 text-white rounded px-4 py-2 w-fit">발급</button>
      </form>

      <section className="space-y-1">
        <h2 className="font-semibold">미사용 초대</h2>
        {invites.length === 0 && <p className="text-sm text-gray-400">없음</p>}
        {invites.map((iv) => (
          <div key={iv.id} className="flex items-center gap-2 text-sm border rounded px-3 py-2">
            <code className="flex-1 truncate">{base}/invite/{iv.token}</code>
            <form action={revokeInviteAction}>
              <input type="hidden" name="inviteId" value={iv.id} />
              <button className="text-xs text-red-500 underline">폐기</button>
            </form>
          </div>
        ))}
      </section>
    </main>
  );
}
