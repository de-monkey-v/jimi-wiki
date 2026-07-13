import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { getOntology, RESERVED_RELATIONS } from "@/lib/ontology";
import { requestsExternalModelScope, withExternalModelResponseScope } from "@/lib/content-api";
import { EXTERNAL_MODEL_SCOPE, listExternalModelCategories } from "@/lib/model-access";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/ontology — 이 위키의 분류 인스턴스(카테고리/관계 어휘). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  return withExternalModelResponseScope(req, gate.wiki.id, async (tx) => {
    void tx; // external category projection uses the ambient model-policy transaction.
    const ontology = requestsExternalModelScope(req)
      ? {
          version: 0,
          categories: await listExternalModelCategories(gate.wiki.id, EXTERNAL_MODEL_SCOPE),
          // Custom ontology metadata may have originated in internalOnly material. The fixed
          // public vocabulary is the only relation projection safe to expose to model clients.
          relationTypes: [...RESERVED_RELATIONS],
        }
      : await getOntology(gate.wiki.id);
    return NextResponse.json({ ontology }, { headers: { "Cache-Control": "no-store" } });
  });
}
