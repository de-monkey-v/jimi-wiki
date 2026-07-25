import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { AddLinkForm } from "./AddLinkForm";
import { ReadingList } from "./ReadingList";

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
    <main className="mx-auto reading-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href={`/wikis/${slug}`}>← {wiki.title}</Link></div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="page-kicker">Reading queue</p>
            <h1 className="page-title">{t("title")}</h1>
            <p className="page-description">{t("subtitle")}</p>
          </div>
          <Link href={`/wikis/${encodeURIComponent(slug)}/settings/trash`} className="btn-secondary shrink-0 text-sm">{t("trash")}</Link>
        </div>
      </header>

      <div className="surface-panel p-4">
      <AddLinkForm wikiSlug={slug} />
      </div>

      {links.length === 0 ? (
        <div className="surface-panel-muted mt-6 p-5 text-sm text-stone-400">{t("empty")}</div>
      ) : (
        <ReadingList
          wikiSlug={slug}
          canPromote={canWrite}
          items={links.map((l) => ({
            id: l.id,
            url: l.url,
            title: l.title,
            description: l.description,
            summary: l.summary,
            savedAt: l.createdAt.toISOString().slice(0, 10),
            promoted: !!l.promotedAt,
          }))}
        />
      )}
    </main>
  );
}
