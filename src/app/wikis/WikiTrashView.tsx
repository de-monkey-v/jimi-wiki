import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/session";
import { listTrashedOwnedWikis } from "@/lib/wiki";
import { purgeWikiAction, restoreWikiAction } from "./manage-actions";
import { unauthenticatedPath } from "@/lib/auth-mode";

export async function WikiTrashView() {
  const user = await getCurrentUser();
  if (!user) redirect(unauthenticatedPath());
  const [wikis, t, format] = await Promise.all([
    listTrashedOwnedWikis(user.id),
    getTranslations("WikisTrashPage"),
    getFormatter(),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/wikis" className="rounded-sm text-sm text-stone-400 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">← {t("back")}</Link>
      <h1 className="mt-2 text-pretty text-2xl font-bold">{t("title")}</h1>
      <p className="mt-1 text-sm text-stone-500">{t("subtitle")}</p>
      {wikis.length === 0 ? (
        <p className="mt-8 text-sm text-stone-400">{t("empty")}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {wikis.map((wiki) => (
            <li key={wiki.id} className="rounded-lg border border-stone-200 p-4">
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
                  <button className="rounded border px-3 py-1.5 text-sm hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("restore")}</button>
                </form>
                <form action={purgeWikiAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="wikiSlug" value={wiki.slug} />
                  <label className="text-xs text-stone-500">
                    {t("purgeConfirm", { slug: wiki.slug })}
                    <input name="confirmSlug" required autoComplete="off" spellCheck={false} className="mt-1 block rounded border px-2 py-1 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" />
                  </label>
                  <button className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500">{t("purge")}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
