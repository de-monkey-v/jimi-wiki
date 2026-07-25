import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/session";
import { listOwnedWikis, listSharedWikis } from "@/lib/wiki";
import { EmptyState } from "@/components/EmptyState";
import { createWikiAction } from "./actions";
import { logoutAction } from "../login/actions";
import { WikiTrashView } from "./WikiTrashView";
import { authMode, unauthenticatedPath } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";

export default async function WikisPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  if (view === "trash") return <WikiTrashView />;

  const user = await getCurrentUser();
  if (!user) redirect(unauthenticatedPath());
  const t = await getTranslations("WikisPage");
  const [owned, shared] = await Promise.all([listOwnedWikis(user.id), listSharedWikis(user.id)]);
  const hasAnyWikis = owned.length > 0 || shared.length > 0;
  const roleLabel = (role: string | null) =>
    role === "owner" || role === "editor" || role === "viewer" ? t(`role.${role}`) : (role ?? "");

  return (
    <main className="mx-auto compact-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="page-kicker">Knowledge registry</p>
          <h1 className="page-title">jimi-wiki</h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-stone-500">
          <Link href="/keys" className="rounded hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("apiKeys")}</Link>
          <Link href="/docs" className="rounded hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("integrationGuide")}</Link>
          <Link href="/wikis?view=trash" className="rounded hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("trash")}</Link>
          <span className="text-stone-300">·</span>
          <span className="text-xs text-stone-400">{user.email}</span>
          {authMode() !== "tailscale" ? (
            <form action={logoutAction}>
              <button className="rounded hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("logout")}</button>
            </form>
          ) : null}
        </div>
        </div>
      </header>
      <h2 className="text-sm font-semibold text-stone-500 mb-2">{t("myWikis")}</h2>

      {/* 내가 만든 위키 */}
      <ul className="space-y-2 mb-8">
        {owned.length === 0 && hasAnyWikis && <li className="text-stone-500">{t("noOwnedWikis")}</li>}
        {owned.map((w) => (
          <li key={w.id} className="surface-panel card-hover p-4">
            <Link href={`/wikis/${w.slug}`} className="flex items-center justify-between gap-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <div className="min-w-0">
                <div className="font-semibold">{w.title}</div>
                {w.description && <div className="truncate text-sm text-stone-500">{w.description}</div>}
              </div>
              <div className="shrink-0 text-xs text-stone-400">
                {w.kind} · {t("pageCount", { count: w._count.pages })}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* 공유받은 위키 */}
      {shared.length > 0 && (
        <div className="mb-10">
          <h2 className="mb-2 text-sm font-semibold text-stone-500">{t("sharedWikis")}</h2>
          <ul className="space-y-2">
            {shared.map((w) => (
              <li key={w.id} className="surface-panel card-hover p-4">
                <Link href={`/wikis/${w.slug}`} className="flex items-center justify-between gap-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  <div className="min-w-0">
                    <div className="font-semibold">{w.title}</div>
                    <div className="truncate text-xs text-stone-400">{t("authoredBy", { name: w.createdBy.name ?? w.createdBy.email })}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-stone-400">
                    <span className="ui-badge">{roleLabel(w.myRole ?? null)}</span>
                    <span>{t("pageCount", { count: w._count.pages })}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hasAnyWikis && (
        <div className="surface-panel mb-8 p-5">
          <EmptyState
            asset="empty-wikis"
            title={t("emptyTitle")}
            body={t("emptyBody")}
          />
        </div>
      )}

      <form action={createWikiAction} className="surface-panel space-y-3 p-5">
        <h2 className="font-semibold text-stone-800">{t("createWiki")}</h2>
        <label htmlFor="new-wiki-title" className="block text-sm font-medium text-stone-700">{t("titleLabel")}</label>
        <input id="new-wiki-title" name="title" required placeholder={t("titlePlaceholder")} className="field-control" />
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
        <button type="submit" className="btn-primary">
          {t("create")}
        </button>
      </form>
    </main>
  );
}
