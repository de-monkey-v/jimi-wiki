import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/session";
import { listTrashedOwnedWikis } from "@/lib/wiki";
import { purgeWikiAction, restoreWikiAction } from "./manage-actions";
import { unauthenticatedPath } from "@/lib/auth-mode";
import { AsyncSubmitButton } from "@/components/AsyncSubmitButton";

export async function WikiTrashView() {
  const user = await getCurrentUser();
  if (!user) redirect(unauthenticatedPath());
  const [wikis, t, format] = await Promise.all([
    listTrashedOwnedWikis(user.id),
    getTranslations("WikisTrashPage"),
    getFormatter(),
  ]);

  return (
    <main className="mx-auto compact-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href="/wikis">← {t("back")}</Link></div>
        <p className="page-kicker">Recovery</p>
        <h1 className="page-title">{t("title")}</h1>
        <p className="page-description">{t("subtitle")}</p>
      </header>
      {wikis.length === 0 ? (
        <p className="mt-8 text-sm text-stone-400">{t("empty")}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {wikis.map((wiki) => (
            <li key={wiki.id} className="surface-panel card-hover p-4">
              <div className="break-words font-semibold">{wiki.title}</div>
              <div className="mt-1 break-words text-xs text-stone-500">
                {t("details", {
                  slug: wiki.slug,
                  pages: wiki._count.pages,
                  sources: wiki._count.sources,
                  purgeAt: wiki.purgeAt ? format.dateTime(wiki.purgeAt, { dateStyle: "medium", timeStyle: "short" }) : "—",
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <form action={restoreWikiAction}>
                  <input type="hidden" name="wikiSlug" value={wiki.slug} />
                  <AsyncSubmitButton idle={t("restore")} pending={t("restorePending")} className="btn-secondary text-sm" />
                </form>
                <form action={purgeWikiAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="wikiSlug" value={wiki.slug} />
                  <label className="text-xs text-stone-500">
                    {t("purgeConfirm", { slug: wiki.slug })}
                    <input name="confirmSlug" required autoComplete="off" spellCheck={false} className="field-control mt-1 block py-1 font-mono text-xs focus-visible:border-rose-500 focus-visible:ring-rose-200" />
                  </label>
                  <AsyncSubmitButton idle={t("purge")} pending={t("purgePending")} className="btn-danger text-sm" />
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
