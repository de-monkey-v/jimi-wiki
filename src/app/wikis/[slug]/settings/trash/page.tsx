import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { hasRole } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import {
  purgePageFromTrashAction,
  purgeSavedLinkAction,
  purgeSourceFromTrashAction,
  restorePageFromTrashAction,
  restoreSavedLinkFromTrashAction,
  restoreSourceFromTrashAction,
} from "../../trash-actions";

export const dynamic = "force-dynamic";

function Hidden({ wikiSlug, name, value }: { wikiSlug: string; name: "id" | "slug"; value: string }) {
  return <><input type="hidden" name="wikiSlug" value={wikiSlug} /><input type="hidden" name={name} value={value} /></>;
}

export default async function WikiContentTrashPage({ params }: { params: Promise<{ slug: string }> }) {
  const wikiSlug = decodeURIComponent((await params).slug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) notFound();
  const [t, format] = await Promise.all([getTranslations("WikiContentTrashPage"), getFormatter()]);
  const canRestore = hasRole(wiki.role, "editor");
  const owner = hasRole(wiki.role, "owner");
  const [savedLinks, pages, sources] = await Promise.all([
    prisma.savedLink.findMany({ where: { wikiId: wiki.id, userId, trashedAt: { not: null } }, orderBy: { trashedAt: "desc" } }),
    prisma.page.findMany({ where: { wikiId: wiki.id, trashedAt: { not: null } }, orderBy: { trashedAt: "desc" } }),
    prisma.source.findMany({ where: { wikiId: wiki.id, trashedAt: { not: null } }, orderBy: { trashedAt: "desc" } }),
  ]);
  const empty = savedLinks.length + pages.length + sources.length === 0;
  const Row = ({
    kind, identity, title, purgeAt, restorable, restoreAction, purgeAction,
  }: {
    kind: "id" | "slug"; identity: string; title: string; purgeAt: Date | null;
    restorable: boolean;
    restoreAction: (formData: FormData) => Promise<void>;
    purgeAction: (formData: FormData) => Promise<void>;
  }) => (
    <li className="rounded-lg border border-stone-200 p-3">
      <div className="break-words font-medium text-stone-900">{title}</div>
      <div className="mt-1 break-words text-xs text-stone-500"><code className="break-all">{identity}</code> · {t("autoDelete", { date: purgeAt ? format.dateTime(purgeAt, { dateStyle: "medium", timeStyle: "short" }) : "—" })}</div>
      {restorable && <div className="mt-3 flex flex-wrap items-end gap-2">
        <form action={restoreAction}><Hidden wikiSlug={wikiSlug} name={kind} value={identity} /><button className="rounded border px-2 py-1 text-sm hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("restore")}</button></form>
        {owner && <form action={purgeAction} className="flex items-end gap-2">
          <Hidden wikiSlug={wikiSlug} name={kind} value={identity} />
          <label className="text-xs text-stone-500">{t("purgeConfirm", { identity })}<input name="confirm" required autoComplete="off" spellCheck={false} className="mt-1 block rounded border px-2 py-1 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" /></label>
          <button className="rounded border border-red-200 px-2 py-1 text-sm text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500">{t("purge")}</button>
        </form>}
      </div>}
    </li>
  );

  return <main className="mx-auto compact-measure px-6 py-8">
    <Link href={`/wikis/${encodeURIComponent(wikiSlug)}`} className="rounded-sm text-sm text-stone-400 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">← {wiki.title}</Link>
    <h1 className="mt-2 text-pretty text-2xl font-bold">{t("title")}</h1>
    <p className="mt-1 text-sm text-stone-500">{t("subtitle")}</p>
    {empty && <p className="mt-8 text-sm text-stone-400">{t("empty")}</p>}
    {savedLinks.length > 0 && <section className="mt-6"><h2 className="mb-2 font-semibold">{t("savedLinks")}</h2><ul className="space-y-2">{savedLinks.map((item) => <Row key={item.id} kind="id" identity={item.id} title={item.title} purgeAt={item.purgeAt} restorable restoreAction={restoreSavedLinkFromTrashAction} purgeAction={purgeSavedLinkAction} />)}</ul></section>}
    {pages.length > 0 && <section className="mt-6"><h2 className="mb-2 font-semibold">{t("pages")}</h2><ul className="space-y-2">{pages.map((item) => <Row key={item.id} kind="slug" identity={item.slug} title={`${item.title} · ${item.kind}`} purgeAt={item.purgeAt} restorable={canRestore} restoreAction={restorePageFromTrashAction} purgeAction={purgePageFromTrashAction} />)}</ul></section>}
    {sources.length > 0 && <section className="mt-6"><h2 className="mb-2 font-semibold">{t("sources")}</h2><ul className="space-y-2">{sources.map((item) => <Row key={item.id} kind="slug" identity={item.slug} title={item.title} purgeAt={item.purgeAt} restorable={canRestore} restoreAction={restoreSourceFromTrashAction} purgeAction={purgeSourceFromTrashAction} />)}</ul></section>}
  </main>;
}
