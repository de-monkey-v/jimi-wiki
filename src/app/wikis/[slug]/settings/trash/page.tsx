import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { hasRole } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { AsyncSubmitButton } from "@/components/AsyncSubmitButton";
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
    <li className="surface-panel card-hover p-3">
      <div className="break-words font-medium text-stone-900">{title}</div>
      <div className="mt-1 break-words text-xs text-stone-500"><code className="break-all">{identity}</code> · {t("autoDelete", { date: purgeAt ? format.dateTime(purgeAt, { dateStyle: "medium", timeStyle: "short" }) : "—" })}</div>
      {restorable && <div className="mt-3 flex flex-wrap items-end gap-2">
        <form action={restoreAction}><Hidden wikiSlug={wikiSlug} name={kind} value={identity} /><AsyncSubmitButton idle={t("restore")} pending={t("restorePending")} className="btn-secondary btn-compact" /></form>
        {owner && <form action={purgeAction} className="flex items-end gap-2">
          <Hidden wikiSlug={wikiSlug} name={kind} value={identity} />
          <label className="text-xs text-stone-500">{t("purgeConfirm", { identity })}<input name="confirm" required autoComplete="off" spellCheck={false} className="field-control mt-1 block py-1 font-mono text-xs focus-visible:border-rose-500 focus-visible:ring-rose-200" /></label>
          <AsyncSubmitButton idle={t("purge")} pending={t("purgePending")} className="btn-danger btn-compact" />
        </form>}
      </div>}
    </li>
  );

  return <main className="mx-auto compact-measure px-4 py-10 sm:px-6">
    <header className="page-header">
      <div className="page-breadcrumb"><Link href={`/wikis/${encodeURIComponent(wikiSlug)}`}>← {wiki.title}</Link></div>
      <p className="page-kicker">Recovery</p>
      <h1 className="page-title">{t("title")}</h1>
      <p className="page-description">{t("subtitle")}</p>
    </header>
    {empty && <div className="surface-panel-muted mt-8 p-5 text-sm text-stone-400">{t("empty")}</div>}
    {savedLinks.length > 0 && <section className="mt-6"><h2 className="mb-2 font-semibold">{t("savedLinks")}</h2><ul className="space-y-2">{savedLinks.map((item) => <Row key={item.id} kind="id" identity={item.id} title={item.title} purgeAt={item.purgeAt} restorable restoreAction={restoreSavedLinkFromTrashAction} purgeAction={purgeSavedLinkAction} />)}</ul></section>}
    {pages.length > 0 && <section className="mt-6"><h2 className="mb-2 font-semibold">{t("pages")}</h2><ul className="space-y-2">{pages.map((item) => <Row key={item.id} kind="slug" identity={item.slug} title={`${item.title} · ${item.kind}`} purgeAt={item.purgeAt} restorable={canRestore} restoreAction={restorePageFromTrashAction} purgeAction={purgePageFromTrashAction} />)}</ul></section>}
    {sources.length > 0 && <section className="mt-6"><h2 className="mb-2 font-semibold">{t("sources")}</h2><ul className="space-y-2">{sources.map((item) => <Row key={item.id} kind="slug" identity={item.slug} title={item.title} purgeAt={item.purgeAt} restorable={canRestore} restoreAction={restoreSourceFromTrashAction} purgeAction={purgeSourceFromTrashAction} />)}</ul></section>}
  </main>;
}
