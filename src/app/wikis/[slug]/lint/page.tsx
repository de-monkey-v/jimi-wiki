import Link from "next/link";
import { notFound } from "next/navigation";
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
  return (
    <section className="border rounded-lg p-4">
      <h2 className="font-semibold mb-2">
        {title} <span className="text-sm text-gray-400">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">없음</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((it, i) => (
            <li key={i}>
              {it.toSlug ? (
                <span>
                  <Link href={`${base}/${encodeURIComponent(it.from!)}`} className="text-blue-600 hover:underline">{it.from}</Link>
                  {" → "}
                  <span className="text-red-600">[[{it.toSlug}]]</span> (없는 페이지)
                </span>
              ) : (
                <Link href={`${base}/${encodeURIComponent(it.slug!)}`} className="text-blue-600 hover:underline">
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
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const { deep, suggest } = await searchParams;
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  if (!hasRole(wiki.role, "editor")) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-gray-500">건강검진은 editor 이상만 실행할 수 있습니다.</p>
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
  const scoreColor = report.score >= 90 ? "text-green-600" : report.score >= 70 ? "text-yellow-600" : "text-red-600";
  const barColor = (s: number) => (s >= 90 ? "bg-green-500" : s >= 70 ? "bg-yellow-500" : "bg-red-500");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 space-y-4">
      <div>
        <Link href={base} className="text-sm text-gray-400 hover:underline">← {wiki.title}</Link>
        <h1 className="text-2xl font-bold mt-1">건강검진 (Lint)</h1>
        <p className="text-sm text-gray-500">전체 {report.pageCount} 페이지</p>
      </div>

      {/* 건강 점수 + 추이(트렌드). 점수는 가중 이슈/페이지수 기반(0~100). */}
      <section className="border rounded-lg p-4 flex items-center gap-6">
        <div>
          <div className="text-xs text-gray-400">건강 점수</div>
          <div className={`text-4xl font-bold ${scoreColor}`}>{report.score}<span className="text-lg text-gray-400"> / 100</span></div>
        </div>
        {trend.length > 1 && (
          <div className="flex-1">
            <div className="text-xs text-gray-400 mb-1">추이 (최근 {trend.length}회 lint)</div>
            <div className="flex items-end gap-1 h-12">
              {trend.map((s, i) => (
                <div key={i} className={`w-3 rounded-sm ${barColor(s)}`} style={{ height: `${Math.max(6, s)}%` }} title={`${s}`} />
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="flex gap-2 text-sm">
        <Link href={`${base}/lint`} className="border rounded px-3 py-1 hover:bg-gray-50">기계 점검</Link>
        <Link href={`${base}/lint?deep=1`} className="border rounded px-3 py-1 hover:bg-gray-50">+ LLM 심층 점검</Link>
      </div>

      <Section title="깨진 링크" items={report.brokenLinks} base={`${base}`} />
      <Section title="고아 페이지 (들어오는 링크 없음)" items={report.orphanPages} base={base} />
      <Section title="나가는 링크 없는 페이지" items={report.noOutLinks} base={base} />
      <Section title="소스 노트 없는 원문" items={report.untreatedSources} base={base} />

      {/* 원문 중복 페이지: 원문을 사실상 복붙한 페이지 — 검색 근거가 중복 노출되는 원인 */}
      <section className="border rounded-lg p-4">
        <h2 className="font-semibold mb-2">
          원문 중복 의심 페이지 <span className="text-sm text-gray-400">({report.sourceDupPages.length})</span>
        </h2>
        {report.sourceDupPages.length === 0 ? (
          <p className="text-sm text-gray-400">없음</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-400">
              본문이 원문과 사실상 동일한 페이지입니다. 검색·AI 답변에서 같은 내용이 근거로 중복 노출되니, 요약으로 고쳐 쓰거나 삭제를 검토하세요.
            </p>
            <ul className="space-y-1 text-sm">
              {report.sourceDupPages.map((d) => (
                <li key={d.pageSlug} className="flex flex-wrap items-center gap-1.5">
                  <Link href={`${base}/${encodeURIComponent(d.pageSlug)}`} className="text-blue-600 hover:underline">
                    {d.pageTitle}
                  </Link>
                  <span className="text-gray-400">≈ 원문</span>
                  <Link href={`${base}/sources/${encodeURIComponent(d.sourceSlug)}`} className="text-blue-600 hover:underline">
                    {d.sourceTitle}
                  </Link>
                  <span className="text-xs text-gray-400">{(d.sim * 100).toFixed(0)}%</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 정크 노트: 출처 없는 note — 손상/테스트 잔재. 삭제 대상 */}
      <section className="border rounded-lg p-4">
        <h2 className="font-semibold mb-2">
          정크 노트 (출처 없음) <span className="text-sm text-gray-400">({report.junkNotes.length})</span>
        </h2>
        {report.junkNotes.length === 0 ? (
          <p className="text-sm text-gray-400">없음</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-400">
              원문(Source)에 연결되지 않은 노트입니다(provenance 없음). 빈/짧은 테스트 잔재면 삭제하고, 내용이 있으면 원문 재연결(재-ingest)을 검토하세요.
            </p>
            <ul className="space-y-1 text-sm">
              {report.junkNotes.map((n) => (
                <li key={n.slug} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/${encodeURIComponent(n.slug)}`} className="text-blue-600 hover:underline">
                    {n.title || n.slug}
                  </Link>
                  <form action={deleteJunkNoteAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="pageSlug" value={n.slug} />
                    <button className="rounded border px-2 py-0.5 text-xs text-red-600 hover:bg-red-50">삭제</button>
                  </form>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 링크 제안: 고립된 파생 페이지에 연결할 관련 페이지(임베딩 유사도). 승인 시 관련 문서로 추가.
          고립 페이지당 임베딩 검색이라 비싸므로 ?suggest=1일 때만 계산한다. */}
      <section className="border rounded-lg p-4">
        <h2 className="font-semibold mb-2">링크 제안 (고립 페이지){suggestOn ? <span className="text-sm text-gray-400"> ({linkSuggestions.length})</span> : null}</h2>
        {!suggestOn ? (
          <p className="text-sm text-gray-500">
            고립된 파생 페이지에 연결할 관련 페이지를 임베딩 유사도로 찾습니다(비용 발생).{" "}
            <Link href={`${base}/lint?suggest=1${deep === "1" ? "&deep=1" : ""}`} className="text-blue-600 hover:underline">계산하기</Link>
          </p>
        ) : linkSuggestions.length === 0 ? (
          <p className="text-sm text-gray-400">고립된 파생 페이지 없음</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-400">
              들어오거나 나가는 링크가 없는 파생 페이지입니다. &quot;적용&quot;하면 부족한 방향에 맞춰 &quot;## 관련 문서&quot;에 `[[링크]]`를 추가합니다(아웃바운드 부족→이 페이지에, 인바운드 부족→후보 페이지에).
            </p>
            <ul className="space-y-2 text-sm">
              {linkSuggestions.map((s) => (
                <li key={s.slug} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/${encodeURIComponent(s.slug)}`} className="text-blue-600 hover:underline">{s.title}</Link>
                  <span className="text-xs text-gray-400">{[s.needs.includes("inbound") ? "인바운드 없음" : null, s.needs.includes("outbound") ? "아웃바운드 없음" : null].filter(Boolean).join(" · ")}</span>
                  <span className="text-gray-400">→</span>
                  {s.candidates.map((c) => (
                    <Link key={c.slug} href={`${base}/${encodeURIComponent(c.slug)}`} className="rounded bg-gray-100 px-1.5 text-blue-600 hover:underline">
                      {c.title} <span className="text-gray-400">{(c.similarity * 100).toFixed(0)}%</span>
                    </Link>
                  ))}
                  <form action={applyLinkSuggestionAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="pageSlug" value={s.slug} />
                    <input type="hidden" name="needs" value={s.needs.join(",")} />
                    <input type="hidden" name="targets" value={s.candidates.map((c) => c.slug).join(",")} />
                    <button className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50">적용</button>
                  </form>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* 카테고리 건강 (거버넌스) */}
      <section className="border rounded-lg p-4 space-y-4">
        <h2 className="font-semibold">카테고리 건강</h2>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-gray-600">
            중복 의심 쌍 <span className="text-gray-400">({report.categoryHealth.nearDup.length})</span>
          </h3>
          {report.categoryHealth.nearDup.length === 0 ? (
            <p className="text-sm text-gray-400">없음</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {report.categoryHealth.nearDup.map((d, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-gray-100 px-1.5">{d.a}</code> ↔{" "}
                  <code className="rounded bg-gray-100 px-1.5">{d.b}</code>
                  <span className="text-xs text-gray-400">{(d.sim * 100).toFixed(0)}%</span>
                  <form action={mergeCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="from" value={d.b} />
                    <input type="hidden" name="into" value={d.a} />
                    <button className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50">{d.b}→{d.a}</button>
                  </form>
                  <form action={mergeCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="from" value={d.a} />
                    <input type="hidden" name="into" value={d.b} />
                    <button className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50">{d.a}→{d.b}</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-gray-600">
            고아 category (페이지 없음) <span className="text-gray-400">({report.categoryHealth.orphanCats.length})</span>
          </h3>
          {report.categoryHealth.orphanCats.length === 0 ? (
            <p className="text-sm text-gray-400">없음</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.categoryHealth.orphanCats.map((c) => (
                <li key={c} className="flex items-center gap-2">
                  <code className="rounded bg-gray-100 px-1.5">{c}</code>
                  <form action={retireCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="slug" value={c} />
                    <button className="rounded border px-2 py-0.5 text-xs text-red-600 hover:bg-red-50">폐기</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-gray-600">
            미분류 파생 페이지 <span className="text-gray-400">({report.categoryHealth.uncategorized.length})</span>
          </h3>
          {report.categoryHealth.uncategorized.length === 0 ? (
            <p className="text-sm text-gray-400">없음</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.categoryHealth.uncategorized.map((p) => (
                <li key={p.slug} className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/${encodeURIComponent(p.slug)}`} className="text-blue-600 hover:underline">
                    {p.title}
                  </Link>
                  <form action={assignCategoryAction} className="inline flex items-center gap-1">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="pageSlug" value={p.slug} />
                    <input name="category" placeholder="ai/rag" className="w-40 rounded border px-2 py-0.5 text-xs" />
                    <button className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50">지정</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-gray-600">
            너무 깊거나 희소한 category <span className="text-gray-400">({report.categoryHealth.deepSparse.length})</span>
          </h3>
          {report.categoryHealth.deepSparse.length === 0 ? (
            <p className="text-sm text-gray-400">없음</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {report.categoryHealth.deepSparse.map((c) => (
                <li key={c.slug} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-gray-100 px-1.5">{c.slug}</code>
                  <span className="text-xs text-gray-400">{c.depth}단 · 페이지 {c.itemCount}개</span>
                  <form action={flattenCategoryAction} className="inline">
                    <input type="hidden" name="wikiSlug" value={slug} />
                    <input type="hidden" name="slug" value={c.slug} />
                    <button className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50">
                      평탄화 → {c.slug.split("/").slice(0, -1).join("/")}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {report.llmNotes !== undefined && (
        <section className="border rounded-lg p-4">
          <h2 className="font-semibold mb-2">LLM 심층 점검</h2>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{report.llmNotes}</p>
        </section>
      )}
    </main>
  );
}
