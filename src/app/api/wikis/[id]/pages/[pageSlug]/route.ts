import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { getPage } from "@/lib/wiki";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/pages/:pageSlug — 페이지 단건(본문 포함). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; pageSlug: string }> }) {
  const { id, pageSlug } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const page = await getPage(gate.wiki.id, pageSlug);
  if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { slug: page.slug, title: page.title, kind: page.kind, category: page.category, body: page.body },
    { headers: { "Cache-Control": "no-store" } },
  );
}
