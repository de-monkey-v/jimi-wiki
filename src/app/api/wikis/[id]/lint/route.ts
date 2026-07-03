import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { lintWiki } from "@/lib/lint";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/wikis/:id/lint — 건강검진(editor). body: { deep?: boolean } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  let body: { deep?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* body 없으면 기계 점검만 */
  }
  try {
    const report = await lintWiki(gate.wiki.id, { deep: !!body?.deep });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
