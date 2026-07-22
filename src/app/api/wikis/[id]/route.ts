import { NextResponse } from "next/server";
import { apiWikiGate, sessionWikiGate } from "@/lib/api-gate";
import { updateWikiSettings } from "@/lib/wiki";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { purgeTrashedWiki, trashWiki } from "@/lib/trash";
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

/** DELETE /api/wikis/:id — 위키 전체를 14일 휴지통으로 이동. 세션 owner + slug 확인만 허용한다. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { confirmSlug?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.confirmSlug !== id) {
    return NextResponse.json({ error: "wiki_confirmation_required" }, { status: 400 });
  }

  const permanent = new URL(req.url).searchParams.get("permanent") === "1";
  if (!permanent) {
    const gate = await sessionWikiGate(id, { minRole: "owner" });
    if (!gate.ok) return gate.res;
    const wiki = await trashWiki({ wikiId: gate.wiki.id, slug: id, userId: gate.user.id });
    return NextResponse.json({ deleted: true, trashed: true, slug: wiki.slug, purgeAt: wiki.purgeAt });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const wiki = await prisma.wiki.findFirst({
    where: { slug: id, trashedAt: { not: null }, memberships: { some: { userId: user.id, role: "owner" } } },
    select: { id: true },
  });
  if (!wiki) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await purgeTrashedWiki(wiki.id, new Date(), true);
  return NextResponse.json({ deleted: true, purged: true, slug: id });
}
