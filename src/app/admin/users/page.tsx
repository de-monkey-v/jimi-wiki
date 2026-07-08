import { getTranslations } from "next-intl/server";
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
  const t = await getTranslations("AdminUsersPage");
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
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <nav className="text-sm text-gray-500 mt-1">
          <span className="text-gray-800">{t("title")}</span> · <a href="/admin/settings" className="underline">{t("appSettings")}</a>
        </nav>
      </div>

      <section className="space-y-2">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 border rounded px-3 py-2">
            <div className="flex-1 min-w-40">
              <span className="font-medium">{u.email}</span>
              {u.isAdmin && <span className="ml-2 text-xs text-emerald-600">admin</span>}
              {!u.passwordHash && <span className="ml-2 text-xs text-amber-600">{t("noPassword")}</span>}
            </div>
            <form action={setUserAdminAction}>
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="admin" value={String(!u.isAdmin)} />
              <button className="text-xs underline">{u.isAdmin ? t("revokeAdmin") : t("grantAdmin")}</button>
            </form>
            <form action={resetPasswordAction} className="flex items-center gap-1">
              <input type="hidden" name="userId" value={u.id} />
              <input name="password" type="password" required minLength={8} placeholder={t("newPasswordPlaceholder")} className="border rounded px-2 py-1 text-xs w-28" />
              <button className="text-xs underline">{t("reset")}</button>
            </form>
          </div>
        ))}
      </section>

      <form action={createUserAction} className="border-t pt-6 grid gap-2">
        <h2 className="font-semibold">{t("createUser")}</h2>
        <input name="email" type="email" required placeholder="email" className="border rounded px-3 py-2" />
        <input name="name" placeholder={t("namePlaceholder")} className="border rounded px-3 py-2" />
        <input name="password" type="password" required minLength={8} placeholder={t("tempPasswordPlaceholder")} className="border rounded px-3 py-2" />
        <button className="bg-stone-900 text-white rounded px-4 py-2 w-fit">{t("create")}</button>
      </form>

      <form action={createInviteAction} className="border-t pt-6 grid gap-2">
        <h2 className="font-semibold">{t("issueInvite")}</h2>
        <input name="email" type="email" placeholder={t("targetEmailPlaceholder")} className="border rounded px-3 py-2" />
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">{t("ttlDaysLabel")}</label>
          <input name="ttlDays" type="number" defaultValue={7} className="border rounded px-3 py-2 w-24" />
        </div>
        <button className="bg-stone-900 text-white rounded px-4 py-2 w-fit">{t("issue")}</button>
      </form>

      <section className="space-y-1">
        <h2 className="font-semibold">{t("unusedInvites")}</h2>
        {invites.length === 0 && <p className="text-sm text-gray-400">{t("none")}</p>}
        {invites.map((iv) => (
          <div key={iv.id} className="flex items-center gap-2 text-sm border rounded px-3 py-2">
            <code className="flex-1 truncate">{base}/invite/{iv.token}</code>
            <form action={revokeInviteAction}>
              <input type="hidden" name="inviteId" value={iv.id} />
              <button className="text-xs text-red-500 underline">{t("revoke")}</button>
            </form>
          </div>
        ))}
      </section>
    </main>
  );
}
