import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { AsyncSubmitButton } from "@/components/AsyncSubmitButton";
import { BuildStatusBadge } from "@/components/BuildStatusBadge";
import { knowledgeBuildStage } from "@/lib/build-ui";
import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import type { BuildMode, BuildStatus, Prisma } from "@/generated/prisma/client";
import { startRebuildAction } from "./actions";

export const dynamic = "force-dynamic";

function inputCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const inputs = (value as { inputs?: unknown }).inputs;
  return Array.isArray(inputs) ? inputs.length : 0;
}

export default async function KnowledgeBuildList({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; archivedPage?: string; archivedSource?: string }>;
}) {
  const [{ slug: rawSlug }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations("KnowledgeBuilds"),
    getLocale(),
  ]);
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const requestedPage = Number(query.page ?? "0");
  const pageIndex = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
  const requestedArchivedPage = Number(query.archivedPage ?? "0");
  const archivedPageIndex = Number.isSafeInteger(requestedArchivedPage) && requestedArchivedPage >= 0 ? requestedArchivedPage : 0;
  const requestedArchivedSource = Number(query.archivedSource ?? "0");
  const archivedSourceIndex = Number.isSafeInteger(requestedArchivedSource) && requestedArchivedSource >= 0 ? requestedArchivedSource : 0;
  const pageSize = 50;
  const archivedPageSize = 50;
  const archivedPageWhere = {
    wikiId: wiki.id,
    archivedAt: { not: null },
    NOT: { kind: "note" as const, source: { is: { archivedAt: { not: null } } } },
  } satisfies Prisma.PageWhereInput;
  const archivedSourceWhere = {
    wikiId: wiki.id,
    archivedAt: { not: null },
  } satisfies Prisma.SourceWhereInput;
  const [builds, totalBuilds, archivedPages, totalArchivedPages, archivedSources, totalArchivedSources] = await Promise.all([
    prisma.knowledgeBuild.findMany({
      where: { wikiId: wiki.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: pageIndex * pageSize,
      take: pageSize,
      select: {
        id: true,
        mode: true,
        status: true,
        model: true,
        inputManifest: true,
        costUsd: true,
        restorable: true,
        forceExtraction: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        publishedAt: true,
        _count: { select: { drafts: true, pageManifest: true, extractions: true } },
      },
    }),
    prisma.knowledgeBuild.count({ where: { wikiId: wiki.id } }),
    prisma.page.findMany({
      where: archivedPageWhere,
      orderBy: { archivedAt: "desc" },
      skip: archivedPageIndex * archivedPageSize,
      take: archivedPageSize,
      select: { slug: true, title: true, archivedAt: true },
    }),
    prisma.page.count({ where: archivedPageWhere }),
    prisma.source.findMany({
      where: archivedSourceWhere,
      orderBy: { archivedAt: "desc" },
      skip: archivedSourceIndex * archivedPageSize,
      take: archivedPageSize,
      select: { slug: true, title: true, archivedAt: true },
    }),
    prisma.source.count({ where: archivedSourceWhere }),
  ]);
  const pageCount = Math.max(1, Math.ceil(totalBuilds / pageSize));
  const archivedPagesPageCount = Math.max(1, Math.ceil(totalArchivedPages / archivedPageSize));
  const archivedSourcesPageCount = Math.max(1, Math.ceil(totalArchivedSources / archivedPageSize));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
  const modeLabel = (mode: BuildMode) => t(`mode.${mode}`);
  const statusLabel = (status: BuildStatus) => t(`status.${status}`);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link href={`/wikis/${encodeURIComponent(slug)}`} className="text-sm text-stone-500 hover:text-stone-800 hover:underline">
        ← {wiki.title}
      </Link>
      <header className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{t("eyebrow")}</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">{t("title")}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">{t("subtitle")}</p>
        </div>
      </header>

      {wiki.role === "owner" ? (
        <section className="mt-7 rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div>
              <h2 className="text-base font-semibold text-stone-900">{t("rebuildHeading")}</h2>
              <p className="mt-1 text-sm leading-6 text-stone-600">{t("rebuildBody")}</p>
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                <span aria-hidden="true" className="mr-1">◆</span>
                {t("externalWarning")}
              </p>
            </div>
            <form action={startRebuildAction} className="min-w-0 space-y-3 md:w-72">
              <input type="hidden" name="wikiSlug" value={slug} />
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                <input name="forceExtraction" type="checkbox" className="mt-0.5 h-4 w-4 accent-indigo-600" />
                <span>
                  <span className="block font-medium">{t("forceLabel")}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-stone-500">{t("forceHelp")}</span>
                </span>
              </label>
              <AsyncSubmitButton
                idle={t("start")}
                pending={t("starting")}
                className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
              />
            </form>
          </div>
        </section>
      ) : (
        <p className="mt-6 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600">{t("ownerOnly")}</p>
      )}

      {totalArchivedPages + totalArchivedSources > 0 ? (
        <section className="mt-8 rounded-2xl border border-stone-200 bg-stone-50 p-5" aria-labelledby="archived-content-heading">
          <h2 id="archived-content-heading" className="text-base font-semibold text-stone-900">{t("archivedHeading")}</h2>
          <p className="mt-1 text-sm text-stone-600">{t("archivedBody")}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{t("archivedPages")}</h3>
              <ul className="mt-2 space-y-1.5">
                {archivedPages.map((page) => (
                  <li key={page.slug}>
                    <Link className="block rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 hover:border-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" href={`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(page.slug)}`}>
                      {page.title}
                    </Link>
                  </li>
                ))}
                {archivedPages.length === 0 ? <li className="text-sm text-stone-400">{t("noneArchived")}</li> : null}
              </ul>
              {totalArchivedPages > archivedPageSize ? (
                <nav aria-label={t("archivedPagesPagination")} className="mt-3 flex items-center justify-between gap-2 text-xs">
                  {archivedPageIndex > 0 ? (
                    <Link className="text-indigo-600 hover:underline" href={`/wikis/${encodeURIComponent(slug)}/builds?archivedPage=${archivedPageIndex - 1}&archivedSource=${archivedSourceIndex}`}>← {t("newerArchived")}</Link>
                  ) : <span />}
                  <span className="font-mono text-stone-400">{t("archivedPageLabel", { current: Math.min(archivedPageIndex + 1, archivedPagesPageCount), total: archivedPagesPageCount })}</span>
                  {archivedPageIndex + 1 < archivedPagesPageCount ? (
                    <Link className="text-indigo-600 hover:underline" href={`/wikis/${encodeURIComponent(slug)}/builds?archivedPage=${archivedPageIndex + 1}&archivedSource=${archivedSourceIndex}`}>{t("olderArchived")} →</Link>
                  ) : <span />}
                </nav>
              ) : null}
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{t("archivedSources")}</h3>
              <ul className="mt-2 space-y-1.5">
                {archivedSources.map((source) => (
                  <li key={source.slug}>
                    <Link className="block rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 hover:border-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" href={`/wikis/${encodeURIComponent(slug)}/sources/${encodeURIComponent(source.slug)}`}>
                      {source.title}
                    </Link>
                  </li>
                ))}
                {archivedSources.length === 0 ? <li className="text-sm text-stone-400">{t("noneArchived")}</li> : null}
              </ul>
              {totalArchivedSources > archivedPageSize ? (
                <nav aria-label={t("archivedSourcesPagination")} className="mt-3 flex items-center justify-between gap-2 text-xs">
                  {archivedSourceIndex > 0 ? (
                    <Link className="text-indigo-600 hover:underline" href={`/wikis/${encodeURIComponent(slug)}/builds?archivedPage=${archivedPageIndex}&archivedSource=${archivedSourceIndex - 1}`}>← {t("newerArchived")}</Link>
                  ) : <span />}
                  <span className="font-mono text-stone-400">{t("archivedPageLabel", { current: Math.min(archivedSourceIndex + 1, archivedSourcesPageCount), total: archivedSourcesPageCount })}</span>
                  {archivedSourceIndex + 1 < archivedSourcesPageCount ? (
                    <Link className="text-indigo-600 hover:underline" href={`/wikis/${encodeURIComponent(slug)}/builds?archivedPage=${archivedPageIndex}&archivedSource=${archivedSourceIndex + 1}`}>{t("olderArchived")} →</Link>
                  ) : <span />}
                </nav>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="build-history-heading">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="build-history-heading" className="text-base font-semibold text-stone-900">{t("historyHeading")}</h2>
          <span className="font-mono text-xs tabular-nums text-stone-400">{t("buildCount", { count: totalBuilds })}</span>
        </div>
        {builds.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-6 py-12 text-center">
            <p className="font-medium text-stone-700">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-stone-500">{t("emptyBody")}</p>
          </div>
        ) : (
          <ol className="space-y-3">
            {builds.map((build) => (
              <li key={build.id}>
                <Link
                  href={`/wikis/${encodeURIComponent(slug)}/builds/${encodeURIComponent(build.id)}`}
                  className="group block rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition hover:border-indigo-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:p-5"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <BuildStatusBadge status={build.status} label={statusLabel(build.status)} />
                        <span className="rounded-full border border-stone-200 px-2 py-1 text-xs font-medium text-stone-600">{modeLabel(build.mode)}</span>
                        {build.forceExtraction ? <span className="text-xs font-medium text-amber-700">{t("forced")}</span> : null}
                      </div>
                      <p className="mt-2 truncate font-mono text-xs text-stone-500" title={build.id}>{build.id}</p>
                      <p className="mt-1 text-xs text-stone-400">{date.format(build.createdAt)}</p>
                    </div>
                    <span className="text-sm font-medium text-indigo-600 group-hover:underline">{t("openDetail")} →</span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-stone-100 pt-4 text-xs sm:grid-cols-3 lg:grid-cols-6">
                    <div><dt className="text-stone-400">{t("stageLabel")}</dt><dd className="mt-1 font-semibold text-stone-700">{t(`stage.${knowledgeBuildStage({ status: build.status, inputCount: inputCount(build.inputManifest), extractionCount: build._count.extractions, draftCount: build._count.drafts })}`)}</dd></div>
                    <div><dt className="text-stone-400">{t("inputs")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums text-stone-700">{inputCount(build.inputManifest)}</dd></div>
                    <div><dt className="text-stone-400">{t("extractions")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums text-stone-700">{build._count.extractions}</dd></div>
                    <div><dt className="text-stone-400">{t("drafts")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums text-stone-700">{build._count.drafts}</dd></div>
                    <div><dt className="text-stone-400">{t("publishedPages")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums text-stone-700">{build._count.pageManifest}</dd></div>
                    <div><dt className="text-stone-400">{t("cost")}</dt><dd className="mt-1 font-mono font-semibold tabular-nums text-stone-700">{build.costUsd == null ? "—" : money.format(build.costUsd)}</dd></div>
                  </dl>
                </Link>
              </li>
            ))}
          </ol>
        )}
        {totalBuilds > pageSize ? (
          <nav aria-label={t("paginationLabel")} className="mt-4 flex items-center justify-between gap-3 text-sm">
            {pageIndex > 0 ? (
              <Link className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" href={`/wikis/${encodeURIComponent(slug)}/builds?page=${pageIndex - 1}`}>
                ← {t("newerBuilds")}
              </Link>
            ) : <span />}
            <span className="font-mono text-xs tabular-nums text-stone-400">{t("buildPageLabel", { current: Math.min(pageIndex + 1, pageCount), total: pageCount })}</span>
            {pageIndex + 1 < pageCount ? (
              <Link className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-indigo-600 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" href={`/wikis/${encodeURIComponent(slug)}/builds?page=${pageIndex + 1}`}>
                {t("olderBuilds")} →
              </Link>
            ) : <span />}
          </nav>
        ) : null}
      </section>
    </main>
  );
}
