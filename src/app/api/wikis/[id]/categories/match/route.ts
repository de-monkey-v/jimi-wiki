import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { matchCategory } from "@/lib/ontology";
import { matchCategorySemantic } from "@/lib/search";
import { requestsExternalModelScope, withExternalModelResponseScope } from "@/lib/content-api";
import { EXTERNAL_MODEL_SCOPE, listExternalModelCategories } from "@/lib/model-access";

export const dynamic = "force-dynamic";

function normalizedTerms(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, " ")
    .replace(/[^a-z0-9가-힣 ]/g, "")
    .split(" ")
    .filter(Boolean);
}

function safeCategoryScore(query: string, slug: string): number {
  const q = normalizedTerms(query);
  const c = normalizedTerms(slug);
  if (q.length === 0 || c.length === 0) return 0;
  const qs = q.join(" ");
  const cs = c.join(" ");
  if (qs === cs) return 1;
  if (qs.includes(cs) || cs.includes(qs)) return 0.85;
  const cq = new Set(q);
  const cc = new Set(c);
  let overlap = 0;
  for (const term of cq) if (cc.has(term)) overlap++;
  return overlap / (cq.size + cc.size - overlap);
}

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

  return withExternalModelResponseScope(req, gate.wiki.id, async (tx) => {
    void tx; // nested helpers read the same client through model-policy AsyncLocalStorage.
    const externalModel = requestsExternalModelScope(req);
    const safeCategories = externalModel
      ? await listExternalModelCategories(gate.wiki.id, EXTERNAL_MODEL_SCOPE)
      : null;
    const [str, vec] = await Promise.all([
      externalModel
        ? Promise.resolve(
            safeCategories!
              .map((category) => ({ ...category, score: safeCategoryScore(String(body.text), category.slug) }))
              .filter((category) => category.score >= 0.5)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5),
          )
        : matchCategory(gate.wiki.id, String(body.text)),
      matchCategorySemantic(gate.wiki.id, String(body.text)),
    ]);
    const allowed = safeCategories ? new Set(safeCategories.map((category) => category.slug)) : null;
    const bySlug = new Map<string, { slug: string; label?: string; score: number }>();
    for (const c of str) bySlug.set(c.slug, { slug: c.slug, label: c.label, score: c.score });
    for (const c of vec) {
      if (allowed && !allowed.has(c.slug)) continue;
      const ex = bySlug.get(c.slug);
      bySlug.set(c.slug, {
        slug: c.slug,
        label: ex?.label ?? (allowed ? c.slug.split("/").at(-1) : undefined),
        score: Math.max(ex?.score ?? 0, c.score),
      });
    }
    const candidates = [...bySlug.values()].sort((a, b) => b.score - a.score).slice(0, 6);
    return NextResponse.json({ candidates }, { headers: { "Cache-Control": "no-store" } });
  });
}
