import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { modelSearch, RESULT_N } from "@/lib/search";
import { EXTERNAL_MODEL_SCOPE, withExternalModelDispatchLock } from "@/lib/model-access";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/search?q=&k= — 하이브리드 검색. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ hits: [] }, { headers: { "Cache-Control": "no-store" } });

  const kRaw = parseInt(url.searchParams.get("k") ?? "", 10);
  const k = Number.isFinite(kRaw) ? Math.min(Math.max(kRaw, 1), 50) : RESULT_N;

  // 이 REST endpoint는 MCP/외부 agent primitive다. local UI FTS와 달리 항상 external-only.
  return withExternalModelDispatchLock(gate.wiki.id, async () => {
    const hits = await modelSearch({ ...EXTERNAL_MODEL_SCOPE, wikiId: gate.wiki.id, queryText: q, k });
    return NextResponse.json({ hits }, { headers: { "Cache-Control": "no-store" } });
  });
}
