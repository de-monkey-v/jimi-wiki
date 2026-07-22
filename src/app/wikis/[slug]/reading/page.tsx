import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { AddLinkForm } from "./AddLinkForm";
import { ReadingRow } from "./ReadingRow";

export const dynamic = "force-dynamic";

/** 읽을거리(read-later) — 개인이 담아둔 링크 목록. 자동 라벨(제목·설명), 항목별 열기/정식편입/삭제. */
export default async function ReadingPage({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugReadingPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const canWrite = hasRole(wiki.role, "editor");

  const links = await prisma.savedLink.findMany({
    where: { userId, wikiId: wiki.id, trashedAt: null },
    orderBy: [{ promotedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }], // 미편입 먼저, 편입됨은 아래로
    select: { id: true, url: true, title: true, description: true, summary: true, createdAt: true, promotedAt: true },
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Link href={`/wikis/${slug}`} className="text-xs text-stone-400 hover:text-stone-600">← {wiki.title}</Link>
      <div className="flex items-center justify-between"><h1 className="mb-1 mt-1 text-2xl font-bold">{t("title")}</h1><Link href={`/wikis/${encodeURIComponent(slug)}/settings/trash`} className="rounded-sm text-sm text-stone-500 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("trash")}</Link></div>
      <p className="mb-4 text-sm text-stone-400">{t("subtitle")}</p>

      <AddLinkForm wikiSlug={slug} />

      {links.length === 0 ? (
        <p className="mt-8 text-sm text-stone-400">{t("empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-stone-100">
          {links.map((l) => (
            <ReadingRow
              key={l.id}
              wikiSlug={slug}
              id={l.id}
              url={l.url}
              title={l.title}
              description={l.description}
              summary={l.summary}
              savedAt={l.createdAt.toISOString().slice(0, 10)}
              promoted={!!l.promotedAt}
              canPromote={canWrite}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
