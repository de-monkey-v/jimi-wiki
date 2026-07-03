import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { reindexEmbeddings } from "@/lib/search";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/wikis/:id/reindex — embedding IS NULL 청크 backfill(선택적 AI). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  try {
    const result = await reindexEmbeddings(gate.wiki.id);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
