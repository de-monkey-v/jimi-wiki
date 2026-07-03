import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { getOntology } from "@/lib/ontology";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/ontology — 이 위키의 분류 인스턴스(카테고리/관계 어휘). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const ontology = await getOntology(gate.wiki.id);
  return NextResponse.json({ ontology }, { headers: { "Cache-Control": "no-store" } });
}
