import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { getPage, deletePage } from "@/lib/wiki";
import { isReservedSlug } from "@/lib/ontology";

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

/**
 * DELETE /api/wikis/:id/pages/:pageSlug — 파생 페이지 삭제(editor).
 * 파생(concept/entity/answer/meta)만 허용. 소스노트(note)는 불변 계층이라 409,
 * 예약 system 페이지(ontology 등)는 403. 상호참조 깨짐은 lint로 이연한다.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; pageSlug: string }> }) {
  const { id, pageSlug } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const page = await getPage(gate.wiki.id, pageSlug);
  if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (isReservedSlug(page.slug)) {
    return NextResponse.json({ error: "cannot_delete_system_page" }, { status: 403 });
  }
  if (page.kind === "note") {
    // 소스 노트는 원문에 충실한 불변 계층 — 삭제 대신 원문/노트를 그대로 둔다.
    return NextResponse.json({ error: "cannot_delete_source_note" }, { status: 409 });
  }
  await deletePage(gate.wiki.id, page.slug);
  return NextResponse.json({ deleted: true, slug: page.slug }, { headers: { "Cache-Control": "no-store" } });
}
