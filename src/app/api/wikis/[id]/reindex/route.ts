import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { reindexEmbeddings } from "@/lib/search";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/wikis/:id/reindex — embedding IS NULL 청크 backfill.
 * 임베딩은 agent primitive(검색이 필요)이자 저비용 경로라 API 키 허용 + 레이트리밋으로 통제.
 * 세션 전용은 생성형 LLM(query/ingest/lint-deep)에만 적용한다. cf. POST /pages {embed:true}도 동일 backfill.
 */
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
