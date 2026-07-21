import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { requestsExternalModelScope } from "@/lib/content-api";
import { reapStaleRuns } from "@/lib/ingest";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/runs/:runId — ingest 잡 상태 폴링(테넌트 격리). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  // 폴링 시 정체 잡 회수(무한 '처리 중…' 방지)
  await reapStaleRuns(gate.wiki.id);

  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.wikiId !== gate.wiki.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // 색인 저하 발행(publishedDegraded): 페이지는 실제로 발행됐지만 파생 색인이 미완이라 run 은 error 로 남는다.
  // 이 경우에만 발행 사실을 함께 알린다 — 외부 에이전트가 "실패"로 오판해 재편입(중복 생성)하지 않도록.
  // ⚠️ "error 인데 output 이 있다"로 추론하면 안 된다: 빌드가 review(초안 승인 대기)를 남긴 뒤
  //    후속 단계에서 예외가 나면 runIngestJob 의 catch 가 status 만 error 로 덮고 output 은 그대로 두므로,
  //    발행이 0건인데 "발행됨"으로 오판하게 된다. 실제 degraded 신호(output.status)만 신뢰한다.
  const outputStatus = (run.output as { status?: unknown } | null)?.status;
  const published = run.status === "error" && outputStatus === "publishedDegraded";

  // internalOnly 로 편입한 잡의 output 에는 그 정책으로 만들어진 페이지 slug 가 담긴다.
  // external 신뢰 스코프(MCP/외부 에이전트) 호출자에게는 노출하지 않는다.
  const runModelAccess = (run.input as { modelAccess?: unknown } | null)?.modelAccess;
  const hideOutput = requestsExternalModelScope(req) && runModelAccess === "internalOnly";
  const showOutput = !hideOutput && (run.status === "done" || published);

  return NextResponse.json(
    {
      runId: run.id,
      status: run.status,
      output: showOutput ? run.output : undefined,
      error: run.status === "error" ? run.error : undefined,
      ...(published ? { published: true } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
