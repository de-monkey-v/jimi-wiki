import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getSourceImpact } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";
import { KnowledgeBadges, type KnowledgeBadgeLabels } from "@/components/KnowledgeBadges";
import { KnowledgeControls } from "@/components/KnowledgeControls";
import { prisma } from "@/lib/db";

// 원문(Source) 읽기 전용 뷰어 — 소스 노트의 provenance 링크 타겟. 불변·원문 그대로.
export default async function SourceView({
  params,
}: {
  params: Promise<{ slug: string; sourceSlug: string }>;
}) {
  const t = await getTranslations("WikisSlugSourcesSourceSlugPage");
  const ts = await getTranslations("KnowledgeStatus");
  const { slug: rawSlug, sourceSlug: rawSourceSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const sourceSlug = decodeURIComponent(rawSourceSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  // 멤버 전용 원문 상세만 archived projection을 포함한다. 공개/모델 loader는 active-only 유지.
  const source = await prisma.source.findUnique({ where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } } });
  if (!source) notFound();

  const canWrite = wiki.role !== "viewer"; // editor·owner만 삭제 UI 노출
  const impact = canWrite ? await getSourceImpact(wiki.id, source.id) : null;

  const html = await renderMarkdown(source.body ?? "", { hrefFor: () => "#", exists: () => false });
  const knowledgeLabels: KnowledgeBadgeLabels = {
    group: ts("group"),
    origin: {
      human: ts("origin.human"),
      generated: ts("origin.generated"),
      mixed: ts("origin.mixed"),
      system: ts("origin.system"),
    },
    modelAccess: {
      external: ts("modelAccess.external"),
      internalOnly: ts("modelAccess.internalOnly"),
    },
  };

  return (
    <main className="mx-auto reading-measure px-4 py-10 sm:px-6">
      <div className="page-breadcrumb">
        <Link href={`/wikis/${slug}`}>{wiki.title}</Link> / {t("source")}
      </div>
      {source.archivedAt && (
        <div className="mb-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span aria-hidden="true" className="mr-1.5">◇</span>
          {ts("archivedSource")}
        </div>
      )}
      <div className="mb-2 mt-3 flex flex-wrap items-center gap-2">
        <KnowledgeBadges modelAccess={source.modelAccess} labels={knowledgeLabels} />
        <span className="font-mono text-xs tabular-nums text-stone-400">{ts("version", { version: source.currentVersion })}</span>
        <Link
          href={`/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}/history`}
          className="rounded-sm text-xs font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {ts("history")}
        </Link>
      </div>
      <div className="page-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="page-kicker">Preserved source</p>
          <h1 className="page-title min-w-0 break-words">{source.title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="ui-badge">{t("readOnlyBadge")}</span>
        </div>
      </div>
      {canWrite && impact ? (
        <div className="mb-6">
          <KnowledgeControls
            resourceType="source"
            wikiSlug={slug}
            resourceSlug={source.slug}
            currentVersion={source.currentVersion}
            modelAccess={source.modelAccess}
            archived={source.archivedAt != null}
            owner={wiki.role === "owner"}
            sourceImpact={{ notes: impact.notes.length, derived: impact.derived.length }}
          />
        </div>
      ) : null}
      {source.url && (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ui-link mb-4 block truncate rounded text-sm"
        >
          {source.url}
        </a>
      )}
      {(source.body ?? "").trim() === "" ? (
        <p className="text-stone-400">{t("emptyBody")}</p>
      ) : (
        <article className="wiki-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </main>
  );
}
