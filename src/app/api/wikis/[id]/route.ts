import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { updateWikiSettings, deleteWiki } from "@/lib/wiki";
import type { Visibility, WikiKind } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id — 위키 메타(Bearer 인증). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const { wiki } = gate;
  return NextResponse.json(
    { id: wiki.id, slug: wiki.slug, title: wiki.title, visibility: wiki.visibility, kind: wiki.kind, role: wiki.role },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** PATCH /api/wikis/:id — 설정 변경(owner). body: { title?, description?, visibility?, kind? } */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  let body: { title?: string; description?: string | null; visibility?: Visibility; kind?: WikiKind };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const w = await updateWikiSettings(gate.wiki.id, body ?? {});
  return NextResponse.json({ id: w.id, slug: w.slug, title: w.title, visibility: w.visibility });
}

/** DELETE /api/wikis/:id — 위키 삭제(owner). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  await deleteWiki(gate.wiki.id);
  return NextResponse.json({ deleted: true });
}
