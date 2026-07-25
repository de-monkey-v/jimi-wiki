import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Prisma, SourceCurationState } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
type Filter = "all" | SourceCurationState;

function parseFilter(value: string | undefined): Filter {
  return value === "preserved" || value === "curated" ? value : "all";
}

function pageHref(wikiSlug: string, state: Filter, page: number): string {
  const params = new URLSearchParams();
  if (state !== "all") params.set("state", state);
  if (page > 0) params.set("page", String(page));
  const query = params.toString();
  return `/wikis/${encodeURIComponent(wikiSlug)}/sources${query ? `?${query}` : ""}`;
}

function sourceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export default async function SourceArchivePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ state?: string; page?: string }>;
}) {
  const [{ slug: rawSlug }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations("SourceArchive"),
    getLocale(),
  ]);
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const state = parseFilter(query.state);
  const requestedPage = Number(query.page ?? "0");
  const pageIndex = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
  const where = {
    wikiId: wiki.id,
    archivedAt: null,
    trashedAt: null,
    ...(state === "all" ? {} : { curationState: state }),
  } satisfies Prisma.SourceWhereInput;
  const [sources, total] = await Promise.all([
    prisma.source.findMany({
      where,
      orderBy: [{ ingestedAt: "desc" }, { id: "desc" }],
      skip: pageIndex * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        slug: true,
        title: true,
        url: true,
        curationState: true,
        ingestedAt: true,
        _count: { select: { contributions: true } },
      },
    }),
    prisma.source.count({ where }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total > 0 && pageIndex >= pageCount) {
    redirect(pageHref(slug, state, pageCount - 1));
  }
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const filters: Filter[] = ["all", "preserved", "curated"];

  return (
    <main className="mx-auto standard-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb">
          <Link href={`/wikis/${encodeURIComponent(slug)}`}>← {wiki.title}</Link>
        </div>
        <p className="page-kicker">{t("eyebrow")}</p>
        <h1 className="page-title">{t("title")}</h1>
        <p className="page-description max-w-2xl">{t("subtitle")}</p>
      </header>

      <nav aria-label={t("filterLabel")} className="mb-5 flex flex-wrap gap-2">
        {filters.map((filter) => {
          const active = state === filter;
          return (
            <Link
              key={filter}
              href={pageHref(slug, filter, 0)}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                active
                  ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                  : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:text-stone-900"
              }`}
            >
              {t(`filter.${filter}`)}
            </Link>
          );
        })}
      </nav>

      {sources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-6 py-14 text-center">
          <p className="font-semibold text-stone-700">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-stone-500">{t("emptyBody")}</p>
        </div>
      ) : (
        <ol className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
          {sources.map((source) => {
            const host = sourceHost(source.url);
            const curated = source.curationState === "curated";
            return (
              <li key={source.slug} className="border-b border-stone-100 last:border-b-0">
                <Link
                  href={`/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(source.slug)}`}
                  className={`group block border-l-4 px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 sm:px-5 ${
                    curated ? "border-l-teal-500 hover:bg-teal-50/40" : "border-l-amber-400 hover:bg-amber-50/40"
                  }`}
                >
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold text-stone-900 group-hover:text-indigo-800">{source.title}</h2>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-400">
                        {host ? <span>{host}</span> : null}
                        <time dateTime={source.ingestedAt.toISOString()}>{date.format(source.ingestedAt)}</time>
                        {source._count.contributions > 0 ? <span>{t("knowledgeCount", { count: source._count.contributions })}</span> : null}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      curated ? "bg-teal-50 text-teal-700" : "bg-amber-50 text-amber-800"
                    }`}>
                      {t(curated ? "status.curated" : "status.preserved")}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {total > PAGE_SIZE ? (
        <nav aria-label={t("paginationLabel")} className="mt-5 flex items-center justify-between gap-3 text-sm">
          {pageIndex > 0 ? (
            <Link className="ui-link rounded" href={pageHref(slug, state, pageIndex - 1)}>← {t("newer")}</Link>
          ) : <span />}
          <span className="font-mono text-xs text-stone-400">
            {t("page", { current: Math.min(pageIndex + 1, pageCount), total: pageCount })}
          </span>
          {pageIndex + 1 < pageCount ? (
            <Link className="ui-link rounded" href={pageHref(slug, state, pageIndex + 1)}>{t("older")} →</Link>
          ) : <span />}
        </nav>
      ) : null}
    </main>
  );
}
