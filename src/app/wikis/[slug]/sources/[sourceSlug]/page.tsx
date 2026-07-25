import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { existingSlugSet, getWikiForUser, getSourceImpact, getSourcePrevNext, getSourceUsedPages } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";
import { KnowledgeBadges, type KnowledgeBadgeLabels } from "@/components/KnowledgeBadges";
import { KnowledgeControls } from "@/components/KnowledgeControls";
import { PageNav } from "@/components/PageNav";
import { prisma } from "@/lib/db";
import { CurateSourceButton } from "./CurateSourceButton";

function hostFor(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// 원문(Source)의 정본 화면. 자동 생성 note는 이 화면으로 리디렉션된다.
export default async function SourceView({
  params,
}: {
  params: Promise<{ slug: string; sourceSlug: string }>;
}) {
  const [t, ts, locale, { slug: rawSlug, sourceSlug: rawSourceSlug }] = await Promise.all([
    getTranslations("WikisSlugSourcesSourceSlugPage"),
    getTranslations("KnowledgeStatus"),
    getLocale(),
    params,
  ]);
  const slug = decodeURIComponent(rawSlug);
  const sourceSlug = decodeURIComponent(rawSourceSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  // 멤버 전용 원문 상세는 archive 후에도 history/restore 진입점을 유지한다.
  const source = await prisma.source.findUnique({ where: { wikiId_slug: { wikiId: wiki.id, slug: sourceSlug } } });
  if (!source) notFound();

  const canWrite = wiki.role !== "viewer";
  const [impact, usedPages, sourceNote, neighbors, existing] = await Promise.all([
    getSourceImpact(wiki.id, source.id),
    getSourceUsedPages(wiki.id, source.id),
    source.curationState === "curated"
      ? prisma.page.findFirst({
          where: { wikiId: wiki.id, sourceId: source.id, kind: "note", archivedAt: null },
          orderBy: [{ currentVersion: "desc" }, { id: "asc" }],
          select: { body: true },
        })
      : null,
    source.archivedAt ? Promise.resolve({ prev: null, next: null }) : getSourcePrevNext(wiki.id, source.id),
    existingSlugSet(wiki.id),
  ]);

  const [sourceHtml, noteHtml] = await Promise.all([
    renderMarkdown(source.body ?? "", { hrefFor: () => "#", exists: () => false }),
    sourceNote?.body.trim()
      ? renderMarkdown(sourceNote.body, {
          hrefFor: (target) => `/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(target)}`,
          exists: (target) => existing.has(target),
        })
      : Promise.resolve(""),
  ]);
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
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const host = hostFor(source.url);
  const curated = source.curationState === "curated";

  return (
    <main className="mx-auto reading-measure px-4 py-10 sm:px-6">
      <div className="page-breadcrumb">
        <Link href={`/wikis/${encodeURIComponent(slug)}/sources`}>← {t("archive")}</Link>
        <span className="mx-1">/</span>
        <span>{wiki.title}</span>
      </div>

      {source.archivedAt ? (
        <div className="mb-4 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span aria-hidden="true" className="mr-1.5">◇</span>
          {ts("archivedSource")}
        </div>
      ) : null}

      <header className="page-header mt-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            curated ? "bg-teal-50 text-teal-700" : "bg-amber-50 text-amber-800"
          }`}>
            {t(curated ? "curatedStatus" : "preservedStatus")}
          </span>
          {host ? <span className="text-xs text-stone-500">{host}</span> : null}
          <time dateTime={source.ingestedAt.toISOString()} className="font-mono text-xs tabular-nums text-stone-400">
            {date.format(source.ingestedAt)}
          </time>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="page-kicker">{t("eyebrow")}</p>
            <h1 className="page-title break-words">{source.title}</h1>
            <p className="page-description">
              {t(curated ? "curatedDescription" : "preservedDescription")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="btn-secondary text-sm">
                {t("originalSite")} ↗
              </a>
            ) : null}
            <Link
              href={`/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(sourceSlug)}/history`}
              className="btn-secondary text-sm"
            >
              {ts("history")}
            </Link>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <KnowledgeBadges modelAccess={source.modelAccess} labels={knowledgeLabels} />
          <span className="font-mono text-xs tabular-nums text-stone-400">{ts("version", { version: source.currentVersion })}</span>
          {canWrite && !source.archivedAt && !curated ? (
            <CurateSourceButton wikiSlug={slug} sourceSlug={source.slug} />
          ) : null}
        </div>
      </header>

      {canWrite ? (
        <div className="mb-7">
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

      {curated && noteHtml ? (
        <section className="mb-8 rounded-2xl border border-teal-100 bg-teal-50/40 p-5 sm:p-6" aria-labelledby="source-summary-heading">
          <div className="mb-3 flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-teal-500" />
            <h2 id="source-summary-heading" className="text-sm font-semibold text-teal-900">{t("summaryHeading")}</h2>
          </div>
          <article className="wiki-content text-stone-700" dangerouslySetInnerHTML={{ __html: noteHtml }} />
        </section>
      ) : null}

      <section aria-labelledby="stored-source-heading">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-stone-200 pb-2">
          <h2 id="stored-source-heading" className="text-sm font-semibold text-stone-700">{t("bodyHeading")}</h2>
          <span className="text-xs text-stone-400">{t("readOnlyBadge")}</span>
        </div>
        {(source.body ?? "").trim() === "" ? (
          <p className="text-sm text-stone-400">{t("emptyBody")}</p>
        ) : (
          <article className="wiki-content" dangerouslySetInnerHTML={{ __html: sourceHtml }} />
        )}
      </section>

      {usedPages.length > 0 ? (
        <section className="mt-12 border-t border-stone-200 pt-4" aria-labelledby="source-derived-heading">
          <h2 id="source-derived-heading" className="mb-3 text-sm font-semibold text-stone-600">{t("derivedHeading")}</h2>
          <ul className="flex flex-wrap gap-2">
            {usedPages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(page.slug)}`}
                  className="chip-hover inline-block rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-stone-700 hover:text-indigo-700"
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <PageNav
        prev={neighbors.prev}
        next={neighbors.next}
        hrefFor={(target) => `/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(target)}`}
      />
    </main>
  );
}
