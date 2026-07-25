import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { listMembers, listShareLinks } from "@/lib/members";
import {
  updateWikiSettingsAction,
  deleteWikiAction,
  inviteMemberAction,
  updateMemberRoleAction,
  removeMemberAction,
  createShareLinkAction,
  revokeShareLinkAction,
} from "../../manage-actions";

const ROLES = ["viewer", "editor", "owner"] as const;

export default async function WikiSettings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const t = await getTranslations("WikisSlugSettingsPage");
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  if (wiki.role !== "owner") {
    return (
      <main className="mx-auto compact-measure px-6 py-10">
        <Link href={`/wikis/${slug}`} className="page-breadcrumb inline-block">← {wiki.title}</Link>
        <div className="surface-panel mt-5 p-5 text-sm text-stone-600">{t("ownerOnly", { role: wiki.role })}</div>
      </main>
    );
  }

  const members = await listMembers(wiki.id);
  const links = await listShareLinks(wiki.id);

  return (
    <main className="mx-auto compact-measure space-y-10 px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href={`/wikis/${slug}`}>← {wiki.title}</Link></div>
        <p className="page-kicker">Wiki control</p>
        <h1 className="page-title">{t("title")}</h1>
      </header>

      {/* 일반 설정 */}
      <section className="surface-panel space-y-4 p-5">
        <h2 className="text-base font-semibold text-stone-800">{t("generalHeading")}</h2>
        <form action={updateWikiSettingsAction} className="space-y-3">
          <input type="hidden" name="wikiSlug" value={slug} />
          <label className="block text-sm font-medium text-stone-700">
            {t("titleLabel")}
            <input name="title" defaultValue={wiki.title} className="field-control mt-1.5" />
          </label>
          <label className="block text-sm font-medium text-stone-700">
            {t("descriptionLabel")}
            <input name="description" defaultValue={wiki.description ?? ""} className="field-control mt-1.5" />
          </label>
          <label className="block text-sm font-medium text-stone-700">
            {t("visibilityLabel")}
            <select name="visibility" defaultValue={wiki.visibility} className="field-control mt-1.5 block">
              <option value="private">{t("visibilityPrivate")}</option>
              <option value="unlisted">{t("visibilityUnlisted")}</option>
            </select>
          </label>
          <button className="btn-primary text-sm">{t("save")}</button>
        </form>
      </section>

      {/* 멤버 */}
      <section className="surface-panel space-y-4 p-5">
        <h2 className="text-base font-semibold text-stone-800">{t("membersHeading")}</h2>
        <ul className="divide-y divide-stone-100">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-col gap-2 py-3 text-sm first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words sm:truncate">{m.user.name ?? m.user.email}</span>
              <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
                <form action={updateMemberRoleAction} className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none">
                  <input type="hidden" name="wikiSlug" value={slug} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <select name="role" defaultValue={m.role} className="field-control min-w-0 flex-1 py-1 text-xs sm:w-auto sm:flex-none">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="btn-secondary btn-compact shrink-0">{t("changeRole")}</button>
                </form>
                <form action={removeMemberAction} className="shrink-0">
                  <input type="hidden" name="wikiSlug" value={slug} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button className="btn-danger btn-compact">{t("remove")}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
        <form action={inviteMemberAction} className="grid gap-2 border-t border-stone-100 pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <input type="hidden" name="wikiSlug" value={slug} />
          <input name="email" type="email" required autoComplete="email" spellCheck={false} placeholder={t("invitePlaceholder")} className="field-control min-w-0 text-sm" />
          <select name="role" defaultValue="viewer" className="field-control text-sm sm:w-auto">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn-primary w-full text-sm sm:w-auto">{t("invite")}</button>
        </form>
      </section>

      {/* 공유 링크 */}
      <section className="surface-panel space-y-4 p-5">
        <h2 className="text-base font-semibold text-stone-800">{t("shareLinksHeading")}</h2>
        <ul className="space-y-2">
          {links.length === 0 && <li className="text-sm text-stone-400">{t("noShareLinks")}</li>}
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-xs text-stone-600">/s/{l.token}</code>
              <form action={revokeShareLinkAction}>
                <input type="hidden" name="wikiSlug" value={slug} />
                <input type="hidden" name="linkId" value={l.id} />
                <button className="btn-danger btn-compact">{t("revoke")}</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={createShareLinkAction}>
          <input type="hidden" name="wikiSlug" value={slug} />
          <button className="btn-secondary text-sm">{t("createShareLink")}</button>
        </form>
      </section>

      {/* 위험 구역 */}
      <section className="surface-panel-danger space-y-3 p-5">
        <h2 className="font-semibold text-rose-700">{t("dangerZone")}</h2>
        <form action={deleteWikiAction}>
          <input type="hidden" name="wikiSlug" value={slug} />
          <p className="mb-2 text-sm text-stone-600">{t("trashDescription")}</p>
          <label className="block text-sm text-stone-700">
            {t("trashConfirm", { slug })}
            <input
              name="confirmSlug"
              required
              pattern={slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}
              autoComplete="off"
              spellCheck={false}
              className="field-control mb-2 mt-1 font-mono text-sm focus-visible:border-rose-500 focus-visible:ring-rose-200"
            />
          </label>
          <button className="btn-danger text-sm">{t("deleteWiki")}</button>
        </form>
      </section>
    </main>
  );
}
