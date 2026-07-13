import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getPage } from "@/lib/wiki";
import { savePageAction } from "../../../actions";
import { MANUAL_KIND_OPTIONS, MANUAL_KINDS } from "@/lib/kinds";

export default async function EditPage({
  params,
}: {
  params: Promise<{ slug: string; pageSlug: string }>;
}) {
  const t = await getTranslations("WikisSlugPageSlugEditPage");
  const tk = await getTranslations("Kinds");
  const { slug: rawSlug, pageSlug: rawPageSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const pageSlug = decodeURIComponent(rawPageSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const page = await getPage(wiki.id, pageSlug);
  if (!page) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 text-sm text-gray-400">
        <Link href={`/wikis/${slug}/${pageSlug}`} className="hover:underline">← {t("backTo", { title: page.title })}</Link>
      </div>

      <form action={savePageAction} className="space-y-4">
        <input type="hidden" name="wikiSlug" value={slug} />
        <input type="hidden" name="pageSlug" value={pageSlug} />
        <input type="hidden" name="expectedVersion" value={page.currentVersion} />

        <div className="flex gap-3">
          <input
            name="title"
            defaultValue={page.title}
            required
            className="flex-1 border rounded px-3 py-2 font-semibold"
          />
          <select name="kind" defaultValue={page.kind} className="border rounded px-3 py-2">
            {MANUAL_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{tk(`${o.value}Option`)}</option>
            ))}
            {/* 시스템 kind(note/meta)는 새로 지정할 수 없지만, 이미 그 kind인 페이지는 값을 보존한다 */}
            {!MANUAL_KINDS.includes(page.kind) && (
              <option value={page.kind}>{tk(page.kind)}</option>
            )}
          </select>
        </div>

        <textarea
          name="body"
          defaultValue={page.body}
          rows={22}
          placeholder={t("bodyPlaceholder")}
          className="w-full border rounded px-3 py-2 font-mono text-sm"
        />

        <div className="flex gap-2">
          <button type="submit" className="bg-stone-900 text-white rounded px-4 py-2">{t("save")}</button>
          <Link href={`/wikis/${slug}/${pageSlug}`} className="border rounded px-4 py-2 hover:bg-gray-50">{t("cancel")}</Link>
        </div>
      </form>
    </main>
  );
}
