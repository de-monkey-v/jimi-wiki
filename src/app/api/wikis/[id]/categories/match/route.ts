import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { matchCategory } from "@/lib/ontology";
import { matchCategorySemantic } from "@/lib/search";

export const dynamic = "force-dynamic";

/** POST /api/wikis/:id/categories/match — {text} → 재사용 후보(문자열+임베딩 병합). auto-merge 아님. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.text) return NextResponse.json({ error: "text_required" }, { status: 400 });

  const [str, vec] = await Promise.all([
    matchCategory(gate.wiki.id, String(body.text)),
    matchCategorySemantic(gate.wiki.id, String(body.text)),
  ]);
  const bySlug = new Map<string, { slug: string; label?: string; score: number }>();
  for (const c of str) bySlug.set(c.slug, { slug: c.slug, label: c.label, score: c.score });
  for (const c of vec) {
    const ex = bySlug.get(c.slug);
    bySlug.set(c.slug, { slug: c.slug, label: ex?.label, score: Math.max(ex?.score ?? 0, c.score) });
  }
  const candidates = [...bySlug.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  return NextResponse.json({ candidates }, { headers: { "Cache-Control": "no-store" } });
}
