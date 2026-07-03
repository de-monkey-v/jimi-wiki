import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { getSource } from "@/lib/wiki";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/sources/:sourceSlug — 원문 단건(본문 포함). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; sourceSlug: string }> }) {
  const { id, sourceSlug } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const source = await getSource(gate.wiki.id, sourceSlug);
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { slug: source.slug, title: source.title, url: source.url, body: source.body, ingestedAt: source.ingestedAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
