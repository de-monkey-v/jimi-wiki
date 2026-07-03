import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { hybridSearch, RESULT_N } from "@/lib/search";

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

  const hits = await hybridSearch(gate.wiki.id, q, k);
  return NextResponse.json({ hits }, { headers: { "Cache-Control": "no-store" } });
}
