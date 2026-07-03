import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { listShareLinks, createShareLink } from "@/lib/members";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/share-links — 공유 링크 목록(owner). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  const links = await listShareLinks(gate.wiki.id);
  return NextResponse.json(
    { links: links.map((l) => ({ id: l.id, token: l.token, role: l.role, expiresAt: l.expiresAt })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** POST /api/wikis/:id/share-links — 공유 링크 생성(owner). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  const link = await createShareLink(gate.wiki.id, "viewer");
  return NextResponse.json({ id: link.id, token: link.token, url: `/s/${link.token}` }, { status: 201 });
}
