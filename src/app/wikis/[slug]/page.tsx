import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, listPages, KIND_LABEL } from "@/lib/wiki";
import { prisma } from "@/lib/db";
import { EmptyState } from "@/components/EmptyState";
import { HomeActions } from "./HomeActions";
import { ReindexForm } from "./ReindexForm";
import { RunStatusBadge } from "./RunStatusBadge";

export default async function WikiHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const { run } = await searchParams;
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const canWrite = wiki.role !== "viewer"; // editor·owner만 쓰기 UI 노출(뷰어는 읽기 전용)

  // ingest 잡 상태 배지(?run=). 테넌트 격리 확인 후 표시.
  const runRow = run ? await prisma.agentRun.findUnique({ where: { id: run } }) : null;
  const runStatus = runRow && runRow.wikiId === wiki.id ? runRow : null;

  const logs = await prisma.logEntry.findMany({
    where: { wikiId: wiki.id },
    orderBy: { createdAt: "desc" },
    take: 6,
  });

  const pages = await listPages(wiki.id);
  const groups = new Map<string, typeof pages>();
  for (const p of pages) {
    if (!groups.has(p.kind)) groups.set(p.kind, []);
    groups.get(p.kind)!.push(p);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold mb-4">{wiki.title}</h1>

      {/* ingest 잡 상태 배지: 진행 중이면 자동 폴링, 완료 시 결과 요약 + 목록 갱신 */}
      {runStatus && (
        <RunStatusBadge
          wikiSlug={slug}
          runId={runStatus.id}
          initial={{
            status: runStatus.status,
            error: runStatus.error,
            summary:
              typeof (runStatus.output as { summary?: string } | null)?.summary === "string"
                ? ((runStatus.output as { summary?: string }).summary as string)
                : null,
            pagesTouched: Array.isArray((runStatus.output as { pagesTouched?: string[] } | null)?.pagesTouched)
              ? ((runStatus.output as { pagesTouched?: string[] }).pagesTouched as string[]).length
              : 0,
          }}
        />
      )}

      {/* 페이지 목록 */}
      {pages.length === 0 && (
        <div className="mb-8 rounded-lg border border-stone-200 bg-white p-5">
          <EmptyState
            asset="empty-pages"
            title="아직 페이지가 없습니다"
            body={
              canWrite
                ? "아래에서 소스를 수집하거나 새 페이지를 만들면 문서와 개념 연결이 이곳에 정리됩니다."
                : "페이지가 추가되면 읽을 수 있는 문서와 개념 연결이 이곳에 표시됩니다."
            }
          />
        </div>
      )}
      <div className="space-y-6 mb-10">
        {[...groups.entries()].map(([kind, ps]) => (
          <section key={kind}>
            <h2 className="font-semibold text-gray-700 mb-2">{KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind}</h2>
            <ul className="space-y-1">
              {ps.map((p) => (
                <li key={p.id}>
                  <Link href={`/wikis/${slug}/${p.slug}`} className="text-blue-600 hover:underline">
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {canWrite && (
      <>
      {/* ingest·새페이지 진입 — 페이지 이동 없이 모달로 (WikiActionsProvider) */}
      <HomeActions slug={slug} />

      {/* 시맨틱 재색인: 수동으로 올린 페이지의 임베딩(선택적 AI)을 채운다 */}
      <ReindexForm wikiSlug={slug} />
      </>
      )}

      {logs.length > 0 && (
        <section className="mt-8 border-t pt-4">
          <h2 className="text-sm font-semibold text-gray-500 mb-2">최근 활동</h2>
          <ul className="space-y-1 text-sm text-gray-500">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-2">
                <span className="text-gray-400">{l.createdAt.toISOString().slice(5, 16).replace("T", " ")}</span>
                <span className="rounded bg-gray-100 px-1.5 text-xs">{l.kind}</span>
                <span className="truncate">{l.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
