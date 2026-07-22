import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/session";
import { listOwnedWikis, listSharedWikis } from "@/lib/wiki";
import { EmptyState } from "@/components/EmptyState";
import { createWikiAction } from "./actions";
import { logoutAction } from "../login/actions";

export default async function WikisPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const t = await getTranslations("WikisPage");
  const [owned, shared] = await Promise.all([listOwnedWikis(user.id), listSharedWikis(user.id)]);
  const hasAnyWikis = owned.length > 0 || shared.length > 0;
  const roleLabel = (role: string | null) =>
    role === "owner" || role === "editor" || role === "viewer" ? t(`role.${role}`) : (role ?? "");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">jimi-wiki</h1>
        <div className="flex items-center gap-3 text-sm text-stone-500">
          <Link href="/keys" className="hover:text-stone-800">{t("apiKeys")}</Link>
          <Link href="/docs" className="hover:text-stone-800">{t("integrationGuide")}</Link>
          <span className="text-stone-300">·</span>
          <span className="text-xs text-stone-400">{user.email}</span>
          <form action={logoutAction}>
            <button className="hover:text-stone-800">{t("logout")}</button>
          </form>
        </div>
      </div>
      <h2 className="text-sm font-semibold text-stone-500 mb-2">{t("myWikis")}</h2>

      {/* 내가 만든 위키 */}
      <ul className="space-y-2 mb-8">
        {owned.length === 0 && hasAnyWikis && <li className="text-gray-500">{t("noOwnedWikis")}</li>}
        {owned.map((w) => (
          <li key={w.id} className="border rounded-lg p-4 hover:bg-gray-50">
            <Link href={`/wikis/${w.slug}`} className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{w.title}</div>
                {w.description && <div className="text-sm text-gray-500">{w.description}</div>}
              </div>
              <div className="text-xs text-gray-400">
                {w.kind} · {t("pageCount", { count: w._count.pages })}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* 공유받은 위키 */}
      {shared.length > 0 && (
        <div className="mb-10">
          <h2 className="text-sm font-semibold text-gray-500 mb-2">{t("sharedWikis")}</h2>
          <ul className="space-y-2">
            {shared.map((w) => (
              <li key={w.id} className="border rounded-lg p-4 hover:bg-gray-50">
                <Link href={`/wikis/${w.slug}`} className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{w.title}</div>
                    <div className="text-xs text-gray-400">{t("authoredBy", { name: w.createdBy.name ?? w.createdBy.email })}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5">{roleLabel(w.myRole ?? null)}</span>
                    <span>{t("pageCount", { count: w._count.pages })}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hasAnyWikis && (
        <div className="mb-8 rounded-lg border border-stone-200 bg-white p-5">
          <EmptyState
            asset="empty-wikis"
            title={t("emptyTitle")}
            body={t("emptyBody")}
          />
        </div>
      )}

      <form action={createWikiAction} className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">{t("createWiki")}</h2>
        <label htmlFor="new-wiki-title" className="block text-sm font-medium text-stone-700">{t("titleLabel")}</label>
        <input id="new-wiki-title" name="title" required placeholder={t("titlePlaceholder")} className="w-full border rounded px-3 py-2" />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="cursor-pointer rounded-lg border border-stone-200 p-3 has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50/50">
            <span className="flex items-center gap-2 font-medium text-stone-800">
              <input type="radio" name="kind" value="personal" defaultChecked className="text-indigo-600" />
              {t("kindPersonal")}
            </span>
            <span className="mt-1 block pl-6 text-xs leading-5 text-stone-500">{t("kindPersonalDescription")}</span>
          </label>
          <label className="cursor-pointer rounded-lg border border-stone-200 p-3 has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50/50">
            <span className="flex items-center gap-2 font-medium text-stone-800">
              <input type="radio" name="kind" value="project" className="text-indigo-600" />
              {t("kindProject")}
            </span>
            <span className="mt-1 block pl-6 text-xs leading-5 text-stone-500">{t("kindProjectDescription")}</span>
          </label>
        </div>
        <button type="submit" className="block bg-stone-900 text-white rounded px-4 py-2">
          {t("create")}
        </button>
      </form>
    </main>
  );
}
