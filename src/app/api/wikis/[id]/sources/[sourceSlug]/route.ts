import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { getSource, deleteSource } from "@/lib/wiki";

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

/**
 * DELETE /api/wikis/:id/sources/:sourceSlug — 원문 삭제(editor).
 * 연결된 소스 노트(요약)도 함께 삭제된다. 정리된 지식(concept/entity)은 보존(출처 표시만 끊김).
 * SearchChunk(원문·노트)는 명시 정리된다(FK 없음). 되돌릴 수 없다.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; sourceSlug: string }> }) {
  const { id, sourceSlug } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const res = await deleteSource(gate.wiki.id, sourceSlug);
  if (!res) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { deleted: true, slug: sourceSlug, deletedNotes: res.deletedNotes },
    { headers: { "Cache-Control": "no-store" } },
  );
}
