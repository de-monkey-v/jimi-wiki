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
      <main className="mx-auto max-w-3xl px-6 py-10">
        <Link href={`/wikis/${slug}`} className="text-sm text-gray-400 hover:underline">← {wiki.title}</Link>
        <p className="mt-6 text-gray-500">{t("ownerOnly", { role: wiki.role })}</p>
      </main>
    );
  }

  const members = await listMembers(wiki.id);
  const links = await listShareLinks(wiki.id);

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-4 py-10 sm:px-6">
      <div>
        <Link href={`/wikis/${slug}`} className="text-sm text-gray-400 hover:underline">← {wiki.title}</Link>
        <h1 className="text-2xl font-bold mt-1">{t("title")}</h1>
      </div>

      {/* 일반 설정 */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">{t("generalHeading")}</h2>
        <form action={updateWikiSettingsAction} className="space-y-3">
          <input type="hidden" name="wikiSlug" value={slug} />
          <label className="block text-sm">
            {t("titleLabel")}
            <input name="title" defaultValue={wiki.title} className="mt-1 w-full border rounded px-3 py-2" />
          </label>
          <label className="block text-sm">
            {t("descriptionLabel")}
            <input name="description" defaultValue={wiki.description ?? ""} className="mt-1 w-full border rounded px-3 py-2" />
          </label>
          <label className="block text-sm">
            {t("visibilityLabel")}
            <select name="visibility" defaultValue={wiki.visibility} className="mt-1 block border rounded px-3 py-2">
              <option value="private">{t("visibilityPrivate")}</option>
              <option value="unlisted">{t("visibilityUnlisted")}</option>
            </select>
          </label>
          <button className="bg-stone-900 text-white rounded px-4 py-2">{t("save")}</button>
        </form>
      </section>

      {/* 멤버 */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">{t("membersHeading")}</h2>
        <ul className="space-y-2">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words sm:truncate">{m.user.name ?? m.user.email}</span>
              <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
                <form action={updateMemberRoleAction} className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none">
                  <input type="hidden" name="wikiSlug" value={slug} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <select name="role" defaultValue={m.role} className="min-w-0 flex-1 rounded border px-2 py-1 sm:flex-none">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="shrink-0 rounded border px-2 py-1 hover:bg-gray-50">{t("changeRole")}</button>
                </form>
                <form action={removeMemberAction} className="shrink-0">
                  <input type="hidden" name="wikiSlug" value={slug} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button className="border rounded px-2 py-1 text-red-600 hover:bg-red-50">{t("remove")}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
        <form action={inviteMemberAction} className="grid gap-2 border-t pt-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <input type="hidden" name="wikiSlug" value={slug} />
          <input name="email" type="email" required placeholder={t("invitePlaceholder")} className="min-w-0 rounded border px-3 py-2 text-sm" />
          <select name="role" defaultValue="viewer" className="w-full rounded border px-2 py-2 text-sm sm:w-auto">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="w-full rounded bg-stone-900 px-3 py-2 text-sm text-white sm:w-auto">{t("invite")}</button>
        </form>
      </section>

      {/* 공유 링크 */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">{t("shareLinksHeading")}</h2>
        <ul className="space-y-2">
          {links.length === 0 && <li className="text-sm text-gray-400">{t("noShareLinks")}</li>}
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <code className="min-w-0 flex-1 truncate rounded bg-gray-100 px-2 py-1 text-xs">/s/{l.token}</code>
              <form action={revokeShareLinkAction}>
                <input type="hidden" name="wikiSlug" value={slug} />
                <input type="hidden" name="linkId" value={l.id} />
                <button className="border rounded px-2 py-1 text-red-600 hover:bg-red-50">{t("revoke")}</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={createShareLinkAction}>
          <input type="hidden" name="wikiSlug" value={slug} />
          <button className="border rounded px-3 py-2 text-sm hover:bg-gray-50">{t("createShareLink")}</button>
        </form>
      </section>

      {/* 위험 구역 */}
      <section className="border border-red-200 rounded-lg p-4 space-y-3">
        <h2 className="font-semibold text-red-700">{t("dangerZone")}</h2>
        <form action={deleteWikiAction}>
          <input type="hidden" name="wikiSlug" value={slug} />
          <button className="bg-red-600 text-white rounded px-4 py-2 text-sm">{t("deleteWiki")}</button>
        </form>
      </section>
    </main>
  );
}
