import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PageNav } from "@/components/PageNav";
import { RelatedPanel } from "@/components/reading/RelatedPanel";
import { ResearchMarkdown } from "./ResearchMarkdown";

type NavItem = { slug: string; title: string } | null;

export type ResearchEvidence = {
  number: number;
  slug: string;
  title: string | null;
  preservedHref: string | null;
  originalUrl: string | null;
  version: number | null;
  contentHash: string | null;
  deleted: boolean;
};

export function ResearchArticle({
  title,
  body,
  wikiSlug,
  pageSlug,
  category,
  existingSlugs,
  evidence,
  canCreate,
  canEdit,
  editHref,
  crumb,
  headerMeta,
  notice,
  controls,
  pinControl,
  backlinks,
  outlinks,
  prev,
  next,
  localGraph,
}: {
  title: string;
  body: string;
  wikiSlug: string;
  pageSlug?: string; // 있으면 본문 텍스트 선택 툴바 활성(비공개 뷰)
  category: string | null;
  existingSlugs: string[];
  evidence: ResearchEvidence[];
  canCreate: boolean;
  canEdit: boolean;
  editHref?: string;
  crumb?: ReactNode;
  headerMeta?: ReactNode;
  notice?: ReactNode;
  controls?: ReactNode;
  pinControl?: ReactNode;
  backlinks: { slug: string; title: string }[];
  outlinks: { slug: string; title: string }[];
  prev: NavItem;
  next: NavItem;
  localGraph?: ReactNode;
}) {
  const t = useTranslations("ResearchArticle");
  const sourceSlugs = evidence.map((source) => source.slug);
  const hrefFor = (slug: string) => `/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(slug)}`;
  return (
    <main className="research-shell">
      <div className="research-header">
        {crumb}
        {notice && <div className="mt-3">{notice}</div>}
        <div className="mb-2 mt-3">{headerMeta}</div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="research-kicker">{t("kicker")}</p>
            <h1>{title}</h1>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {pinControl}
            {canEdit && editHref && (
              <Link href={editHref} className="btn-secondary text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                {t("edit")}
              </Link>
            )}
          </div>
        </div>
        {controls && <div className="mt-5">{controls}</div>}
      </div>

      <div className="research-notebook">
        <article className="research-paper">
          <ResearchMarkdown
            body={body}
            sourceSlugs={sourceSlugs}
            wikiSlug={wikiSlug}
            category={category}
            existingSlugs={existingSlugs}
            canCreate={canCreate}
            selection={pageSlug ? { pageSlug, canWrite: canCreate } : undefined}
          />
        </article>
        <aside className="research-evidence" aria-labelledby="research-evidence-heading">
          <div className="research-evidence-sticky">
            <div className="research-evidence-heading">
              <h2 id="research-evidence-heading">{t("evidenceHeading")}</h2>
              <span>{evidence.length}</span>
            </div>
            <ol>
              {evidence.map((source) => (
                <li
                  key={`${source.number}-${source.slug}`}
                  id={`research-evidence-${source.number}`}
                  className={source.deleted ? "is-deleted" : undefined}
                >
                  <a
                    className="research-evidence-number"
                    href={`#research-citation-${source.number}-1`}
                    aria-label={t("backToCitation", { number: source.number })}
                  >
                    {source.number}
                  </a>
                  <div>
                    <p className="research-evidence-title">
                      {source.deleted ? t("deletedEvidence") : source.title ?? source.slug}
                    </p>
                    <p className="research-evidence-meta">
                      {source.slug}
                      {source.version ? ` · v${source.version}` : ""}
                    </p>
                    <div className="research-evidence-links">
                      {source.preservedHref && <Link href={source.preservedHref}>{t("preservedCopy")}</Link>}
                      {source.originalUrl && (
                        <a href={source.originalUrl} target="_blank" rel="noopener noreferrer">
                          {t("original")}
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      <div className="research-footer">
        <PageNav prev={prev} next={next} hrefFor={hrefFor} />
        {localGraph}
        <RelatedPanel outlinks={outlinks} backlinks={backlinks} hrefFor={hrefFor} />
      </div>
    </main>
  );
}
