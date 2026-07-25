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
    <main className="mx-auto compact-measure space-y-8 px-4 py-12 sm:px-6">
      <header className="page-header">
        <p className="page-kicker">Administration</p>
        <h1 className="page-title">{t("title")}</h1>
        <nav className="mt-2 text-sm text-stone-500">
          <span className="text-stone-800">{t("title")}</span> · <a href="/admin/settings" className="ui-link rounded">{t("appSettings")}</a>
        </nav>
      </header>

      <section className="surface-panel space-y-2 p-5">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 px-3 py-2">
            <div className="flex-1 min-w-40">
              <span className="font-medium">{u.email}</span>
              {u.isAdmin && <span className="ml-2 text-xs text-emerald-600">admin</span>}
              {!u.passwordHash && <span className="ml-2 text-xs text-amber-600">{t("noPassword")}</span>}
            </div>
            <form action={setUserAdminAction}>
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="admin" value={String(!u.isAdmin)} />
              <button className="ui-link rounded text-xs">{u.isAdmin ? t("revokeAdmin") : t("grantAdmin")}</button>
            </form>
            <form action={resetPasswordAction} className="flex items-center gap-1">
              <input type="hidden" name="userId" value={u.id} />
              <input name="password" type="password" required minLength={8} autoComplete="new-password" aria-label={t("newPasswordPlaceholder")} placeholder={t("newPasswordPlaceholder")} className="field-control w-32 py-1 text-xs" />
              <button className="ui-link rounded text-xs">{t("reset")}</button>
            </form>
          </div>
        ))}
      </section>

      <form action={createUserAction} className="surface-panel grid gap-2 p-5">
        <h2 className="font-semibold">{t("createUser")}</h2>
        <input name="email" type="email" required autoComplete="email" spellCheck={false} aria-label="Email" placeholder="email" className="field-control" />
        <input name="name" autoComplete="name" aria-label={t("namePlaceholder")} placeholder={t("namePlaceholder")} className="field-control" />
        <input name="password" type="password" required minLength={8} autoComplete="new-password" aria-label={t("tempPasswordPlaceholder")} placeholder={t("tempPasswordPlaceholder")} className="field-control" />
        <button className="btn-primary w-fit">{t("create")}</button>
      </form>

      <form action={createInviteAction} className="surface-panel grid gap-2 p-5">
        <h2 className="font-semibold">{t("issueInvite")}</h2>
        <input name="email" type="email" autoComplete="email" spellCheck={false} aria-label={t("targetEmailPlaceholder")} placeholder={t("targetEmailPlaceholder")} className="field-control" />
        <div className="flex items-center gap-2">
          <label htmlFor="invite-ttl-days" className="text-sm text-stone-500">{t("ttlDaysLabel")}</label>
          <input id="invite-ttl-days" name="ttlDays" type="number" defaultValue={7} className="field-control w-24" />
        </div>
        <button className="btn-primary w-fit">{t("issue")}</button>
      </form>

      <section className="surface-panel space-y-2 p-5">
        <h2 className="font-semibold">{t("unusedInvites")}</h2>
        {invites.length === 0 && <p className="text-sm text-stone-400">{t("none")}</p>}
        {invites.map((iv) => (
          <div key={iv.id} className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm">
            <code className="flex-1 truncate">{base}/invite/{iv.token}</code>
            <form action={revokeInviteAction}>
              <input type="hidden" name="inviteId" value={iv.id} />
              <button className="btn-danger btn-compact">{t("revoke")}</button>
            </form>
          </div>
        ))}
      </section>
    </main>
  );
}
