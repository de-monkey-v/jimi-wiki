import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
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
  return NextResponse.json(
    {
      runId: run.id,
      status: run.status,
      output: run.status === "done" ? run.output : undefined,
      error: run.status === "error" ? run.error : undefined,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
