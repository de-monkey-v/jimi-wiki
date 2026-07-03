import { NextResponse, after } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { createIngestRun, runIngestJob, type IngestInput } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 서버리스 대비(self-host Node는 무제한)

/** POST /api/wikis/:id/ingest — 비동기. 즉시 202 + runId 반환, 처리는 백그라운드(after). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;

  let input: IngestInput;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!input || typeof input !== "object" || (!input.url && !input.text)) {
    return NextResponse.json({ error: "url_or_text_required" }, { status: 400 });
  }

  const run = await createIngestRun(gate.wiki.id, input, gate.user.id);
  after(() =>
    runIngestJob({ id: run.id, wikiId: gate.wiki.id, input, userId: gate.user.id }).catch((e) =>
      console.error(`[ingest] runIngestJob 실패: ${(e as Error).message}`),
    ),
  );

  return NextResponse.json({ runId: run.id, status: "pending" }, { status: 202 });
}
