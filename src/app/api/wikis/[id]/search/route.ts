import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { expandViaGraph, modelSearch, parseSearchScope, requestedGraphDepth, RESULT_N } from "@/lib/search";
import { EXTERNAL_MODEL_SCOPE, withExternalModelDispatchLock } from "@/lib/model-access";
import { parseDocumentType } from "@/lib/documents";

export const dynamic = "force-dynamic";

/**
 * GET /api/wikis/:id/search?q=&k=&graph=1&depth= — 하이브리드 검색.
 * graph=1 이면 히트 페이지를 시드로 지식그래프(ConceptRelation)를 확장해 neighbors 를 함께 반환한다.
 * graph 미요청 시 응답 형태는 { hits } 그대로(하위호환).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const scope = parseSearchScope(url.searchParams.get("scope"));
  if (!scope) return NextResponse.json({ error: "invalid_search_scope" }, { status: 400 });
  const typeRaw = url.searchParams.get("type");
  const documentType = typeRaw === null ? undefined : parseDocumentType(typeRaw) ?? undefined;
  if (typeRaw !== null && (!documentType || scope !== "documents")) {
    return NextResponse.json({ error: "invalid_document_type_filter" }, { status: 400 });
  }
  if (!q) {
    const empty = scope === "all"
      ? { groups: { knowledge: { hits: [] }, documents: { hits: [] } } }
      : { hits: [] };
    return NextResponse.json(empty, { headers: { "Cache-Control": "no-store" } });
  }

  const kRaw = parseInt(url.searchParams.get("k") ?? "", 10);
  const k = Number.isFinite(kRaw) ? Math.min(Math.max(kRaw, 1), 50) : RESULT_N;

  // 이 REST endpoint는 MCP/외부 agent primitive다. local UI FTS와 달리 항상 external-only.
  const depth = requestedGraphDepth({ graph: url.searchParams.get("graph"), depth: url.searchParams.get("depth") });
  if (depth > 0 && scope !== "knowledge") {
    return NextResponse.json({ error: "graph_requires_knowledge_scope" }, { status: 400 });
  }

  return withExternalModelDispatchLock(gate.wiki.id, async () => {
    if (scope === "all") {
      const [knowledge, documents] = await Promise.all([
        modelSearch({ ...EXTERNAL_MODEL_SCOPE, wikiId: gate.wiki.id, queryText: q, k, scope: "knowledge" }),
        modelSearch({ ...EXTERNAL_MODEL_SCOPE, wikiId: gate.wiki.id, queryText: q, k, scope: "documents" }),
      ]);
      return NextResponse.json(
        { groups: { knowledge: { hits: knowledge }, documents: { hits: documents } } },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const hits = await modelSearch({
      ...EXTERNAL_MODEL_SCOPE,
      wikiId: gate.wiki.id,
      queryText: q,
      k,
      scope,
      documentType,
    });
    if (depth <= 0) return NextResponse.json({ hits }, { headers: { "Cache-Control": "no-store" } });
    // expandViaGraph 는 순수 SQL(임베딩 호출 없음)이고 내부에서 external-only 로 재격리하며, 실패 시 [] 를 돌려준다.
    const seedPageIds = hits.filter((h) => h.refType === "page").map((h) => h.refId);
    const neighbors = await expandViaGraph(gate.wiki.id, seedPageIds, depth);
    return NextResponse.json({ hits, neighbors }, { headers: { "Cache-Control": "no-store" } });
  });
}
