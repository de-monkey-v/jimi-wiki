import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { lintWiki } from "@/lib/lint";
import { mergeCategoryAction, retireCategoryAction, assignCategoryAction, flattenCategoryAction } from "./actions";

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
  searchParams: Promise<{ deep?: string }>;
}) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const { deep } = await searchParams;
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

  const report = await lintWiki(wiki.id, { deep: deep === "1" });
  const base = `/wikis/${slug}`;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 space-y-4">
      <div>
        <Link href={base} className="text-sm text-gray-400 hover:underline">← {wiki.title}</Link>
        <h1 className="text-2xl font-bold mt-1">건강검진 (Lint)</h1>
        <p className="text-sm text-gray-500">전체 {report.pageCount} 페이지</p>
      </div>

      <div className="flex gap-2 text-sm">
        <Link href={`${base}/lint`} className="border rounded px-3 py-1 hover:bg-gray-50">기계 점검</Link>
        <Link href={`${base}/lint?deep=1`} className="border rounded px-3 py-1 hover:bg-gray-50">+ LLM 심층 점검</Link>
      </div>

      <Section title="깨진 링크" items={report.brokenLinks} base={`${base}`} />
      <Section title="고아 페이지 (들어오는 링크 없음)" items={report.orphanPages} base={base} />
      <Section title="나가는 링크 없는 페이지" items={report.noOutLinks} base={base} />
      <Section title="소스 노트 없는 원문" items={report.untreatedSources} base={base} />

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
