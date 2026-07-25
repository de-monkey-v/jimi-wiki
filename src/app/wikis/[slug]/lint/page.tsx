import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { lintWiki, suggestIsolatedLinks } from "@/lib/lint";
import { prisma } from "@/lib/db";
import {
  mergeCategoryAction,
  retireCategoryAction,
  assignCategoryAction,
  flattenCategoryAction,
  deleteJunkNoteAction,
  applyLinkSuggestionAction,
} from "./actions";

export const dynamic = "force-dynamic";

function Section({ title, items, base }: { title: string; items: { slug?: string; title?: string; from?: string; toSlug?: string }[]; base: string }) {
  const t = useTranslations("WikisSlugLintPage");
  return (
    <section className="surface-panel p-5">
      <h2 className="mb-2 font-semibold text-stone-800">
        {title} <span className="text-sm text-stone-400">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-stone-400">{t("empty")}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((it, i) => (
            <li key={i}>
              {it.toSlug ? (
                <span>
                  <Link href={`${base}/${encodeURIComponent(it.from!)}`} className="ui-link">{it.from}</Link>
                  {" → "}
                  <span className="text-rose-600">[[{it.toSlug}]]</span> ({t("missingPage")})
                </span>
              ) : (
                <Link href={`${base}/${encodeURIComponent(it.slug!)}`} className="ui-link">
                  {it.title ?? it.slug}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function LintPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ deep?: string; suggest?: string }>;
}) {
  const t = await getTranslations("WikisSlugLintPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const { deep, suggest } = await searchParams;
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  if (!hasRole(wiki.role, "editor")) {
    return (
      <main className="mx-auto compact-measure px-4 py-10 sm:px-6">
        <div className="surface-panel p-5 text-sm text-stone-600">{t("editorOnly")}</div>
      </main>
    );
  }

  // page 방문 시엔 persist를 넘기지 않아 트렌드가 오염되지 않는다(측정은 API/MCP/ingest 경로에서만 기록).
  const report = await lintWiki(wiki.id, { deep: deep === "1" });
  const base = `/wikis/${slug}`;

  // 건강 점수 추이: persist된 lint 실행(AgentRun type=lint)만. 최신순 조회 후 시간순으로 뒤집어 표시.
  const runs = await prisma.agentRun.findMany({
    where: { wikiId: wiki.id, type: "lint" },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { output: true },
  });
  const trend = runs
    .map((r) => (r.output as { score?: number } | null)?.score)
    .filter((s): s is number => typeof s === "number")
    .reverse();
  // 링크 제안은 고립 페이지당 임베딩 검색이 들어가 비싸므로 ?suggest=1일 때만 계산(매 방문 팬아웃 방지).
  // 실패는 치명적이지 않으니 빈 목록으로 강등한다.
  const suggestOn = suggest === "1";
  const linkSuggestions = suggestOn ? await suggestIsolatedLinks(wiki.id).catch(() => []) : [];
  const scoreColor = report.score >= 90 ? "text-emerald-600" : report.score >= 70 ? "text-amber-600" : "text-rose-600";
  const barColor = (s: number) => (s >= 90 ? "bg-emerald-500" : s >= 70 ? "bg-amber-500" : "bg-rose-500");

  return (
    <main className="mx-auto compact-measure space-y-4 px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href={base}>← {wiki.title}</Link></div>
        <p className="page-kicker">Knowledge health</p>
        <h1 className="page-title">{t("title")}</h1>
        <p className="page-description">{t("pageCountLabel", { count: report.pageCount })}</p>
      </header>

      {/* 건강 점수 + 추이(트렌드). 점수는 가중 이슈/페이지수 기반(0~100). */}
      <section className="surface-panel flex items-center gap-6 p-5">
        <div>
          <div className="text-xs text-stone-400">{t("healthScore")}</div>
          <div className={`text-4xl font-bold ${scoreColor}`}>{report.score}<span className="text-lg text-stone-400"> / 100</span></div>
        </div>
        {trend.length > 1 && (
          <div className="flex-1">
            <div className="text-xs text-stone-400 mb-1">{t("trendLabel", { count: trend.length })}</div>
            <div className="flex items-end gap-1 h-12">
              {trend.map((s, i) => (
                <div key={i} className={`w-3 rounded-sm ${barColor(s)}`} style={{ height: `${Math.max(6, s)}%` }} title={`${s}`} />
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link href={`${base}/lint`} className="btn-secondary">{t("machineCheck")}</Link>
        <Link href={`${base}/lint?deep=1`} className="btn-secondary">{t("deepCheckButton")}</Link>
      </div>

      <Section title={t("brokenLinks")} items={report.brokenLinks} base={`${base}`} />
      <Section title={t("orphanPages")} items={report.orphanPages} base={base} />
      <Section title={t("noOutLinks")} items={report.noOutLinks} base={base} />
      <Section title={t("untreatedSources")} items={report.untreatedSources} base={base} />

      {/* 원문 중복 페이지: 원문을 사실상 복붙한 페이지 — 검색 근거가 중복 노출되는 원인 */}
      <section className="surface-panel p-5">
        <h2 className="font-semibold mb-2">
          {t("sourceDupTitle")} <span className="text-sm text-stone-400">({report.sourceDupPages.length})</span>
        </h2>
        {report.sourceDupPages.length === 0 ? (
          <p className="text-sm text-stone-400">{t("empty")}</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-stone-400">
              {t("sourceDupDesc")}
            </p>
            <ul className="space-y-1 text-sm">
              {report.sourceDupPages.map((d) => (
                <li key={d.pageSlug} className="flex flex-wrap items-center gap-1.5">
                  <Link href={`${base}/${encodeURIComponent(d.pageSlug)}`} className="ui-link">
                    {d.pageTitle}
                  </Link>
                  <span className="text-stone-400">{t("approxSource")}</span>
                  <Link href={`${base}/sources/${encodeURIComponent(d.sourceSlug)}`} className="ui-link">
                    {d.sourceTitle}
                  </Link>
                  <span className="text-xs text-stone-400">{(d.sim * 100).toFixed(0)}%</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 정크 노트: 출처 없는 note — 손상/테스트 잔재. 삭제 대상 */}
      <section className="surface-panel p-5">
        <h2 className="font-semibold mb-2">
          {t("junkNotesTitle")} <span className="text-sm text-stone-400">({report.junkNotes.length})</span>
        </h2>
        {report.junkNotes.length === 0 ? (
          <p className="text-sm text-stone-400">{t("empty")}</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-stone-400">
              {t("junkNotesDesc")}
            </p>
            <ul className="space-y-1 text-sm">
              {report.junkNotes.map((n) => (
                <li key={n.slug} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/${encodeURIComponent(n.slug)}`} className="ui-link">
                    {n.title || n.slug}
                  </Link>
                  <form action={deleteJunkNoteAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="pageSlug" value={n.slug} />
                    <button className="btn-danger btn-compact">{t("delete")}</button>
                  </form>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 링크 제안: 고립된 파생 페이지에 연결할 관련 페이지(임베딩 유사도). 승인 시 관련 문서로 추가.
          고립 페이지당 임베딩 검색이라 비싸므로 ?suggest=1일 때만 계산한다. */}
      <section className="surface-panel p-5">
        <h2 className="font-semibold mb-2">{t("linkSuggestTitle")}{suggestOn ? <span className="text-sm text-stone-400"> ({linkSuggestions.length})</span> : null}</h2>
        {!suggestOn ? (
          <p className="text-sm text-stone-500">
            {t("linkSuggestPrompt")}{" "}
            <Link href={`${base}/lint?suggest=1${deep === "1" ? "&deep=1" : ""}`} className="ui-link">{t("calculate")}</Link>
          </p>
        ) : linkSuggestions.length === 0 ? (
          <p className="text-sm text-stone-400">{t("noIsolatedPages")}</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-stone-400">
              {t("linkSuggestDesc")}
            </p>
            <ul className="space-y-2 text-sm">
              {linkSuggestions.map((s) => (
                <li key={s.slug} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/${encodeURIComponent(s.slug)}`} className="ui-link">{s.title}</Link>
                  <span className="text-xs text-stone-400">{[s.needs.includes("inbound") ? t("noInbound") : null, s.needs.includes("outbound") ? t("noOutbound") : null].filter(Boolean).join(" · ")}</span>
                  <span className="text-stone-400">→</span>
                  {s.candidates.map((c) => (
                    <Link key={c.slug} href={`${base}/${encodeURIComponent(c.slug)}`} className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-indigo-700 hover:bg-indigo-100">
                      {c.title} <span className="text-stone-400">{(c.similarity * 100).toFixed(0)}%</span>
                    </Link>
                  ))}
                  <form action={applyLinkSuggestionAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="pageSlug" value={s.slug} />
                    <input type="hidden" name="needs" value={s.needs.join(",")} />
                    <input type="hidden" name="targets" value={s.candidates.map((c) => c.slug).join(",")} />
                    <button className="btn-secondary btn-compact">{t("apply")}</button>
                  </form>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 카테고리 건강 (거버넌스) */}
      <section className="surface-panel space-y-5 p-5">
        <h2 className="font-semibold">{t("categoryHealth")}</h2>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-stone-600">
            {t("nearDupTitle")} <span className="text-stone-400">({report.categoryHealth.nearDup.length})</span>
          </h3>
          {report.categoryHealth.nearDup.length === 0 ? (
            <p className="text-sm text-stone-400">{t("empty")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {report.categoryHealth.nearDup.map((d, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-stone-100 px-1.5">{d.a}</code> ↔{" "}
                  <code className="rounded bg-stone-100 px-1.5">{d.b}</code>
                  <span className="text-xs text-stone-400">{(d.sim * 100).toFixed(0)}%</span>
                  <form action={mergeCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="from" value={d.b} />
                    <input type="hidden" name="into" value={d.a} />
                    <button className="btn-secondary btn-compact">{d.b}→{d.a}</button>
                  </form>
                  <form action={mergeCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="from" value={d.a} />
                    <input type="hidden" name="into" value={d.b} />
                    <button className="btn-secondary btn-compact">{d.a}→{d.b}</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-stone-600">
            {t("orphanCatsTitle")} <span className="text-stone-400">({report.categoryHealth.orphanCats.length})</span>
          </h3>
          {report.categoryHealth.orphanCats.length === 0 ? (
            <p className="text-sm text-stone-400">{t("empty")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.categoryHealth.orphanCats.map((c) => (
                <li key={c} className="flex items-center gap-2">
                  <code className="rounded bg-stone-100 px-1.5">{c}</code>
                  <form action={retireCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="slug" value={c} />
                    <button className="btn-danger btn-compact">{t("retire")}</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-stone-600">
            {t("uncategorizedTitle")} <span className="text-stone-400">({report.categoryHealth.uncategorized.length})</span>
          </h3>
          {report.categoryHealth.uncategorized.length === 0 ? (
            <p className="text-sm text-stone-400">{t("empty")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.categoryHealth.uncategorized.map((p) => (
                <li key={p.slug} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/${encodeURIComponent(p.slug)}`} className="ui-link">
                    {p.title}
                  </Link>
                  <form action={assignCategoryAction} className="inline flex items-center gap-1">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="pageSlug" value={p.slug} />
                    <input name="category" placeholder="ai/rag" className="field-control w-40 py-1 text-xs" />
                    <button className="btn-secondary btn-compact">{t("assign")}</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-stone-600">
            {t("deepSparseTitle")} <span className="text-stone-400">({report.categoryHealth.deepSparse.length})</span>
          </h3>
          {report.categoryHealth.deepSparse.length === 0 ? (
            <p className="text-sm text-stone-400">{t("empty")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.categoryHealth.deepSparse.map((c) => (
                <li key={c.slug} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-stone-100 px-1.5">{c.slug}</code>
                  <span className="text-xs text-stone-400">{t("depthPages", { depth: c.depth, count: c.itemCount })}</span>
                  <form action={flattenCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="slug" value={c.slug} />
                    <button className="btn-secondary btn-compact">
                      {t("flatten")} → {c.slug.split("/").slice(0, -1).join("/")}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {report.llmNotes !== undefined && (
        <section className="surface-panel p-5">
          <h2 className="font-semibold mb-2">{t("deepCheckTitle")}</h2>
          <p className="text-sm text-stone-700 whitespace-pre-wrap">{report.llmNotes}</p>
        </section>
      )}
    </main>
  );
}
