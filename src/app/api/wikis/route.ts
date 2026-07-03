import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/apikey";
import { createWiki, listWikisForUser } from "@/lib/wiki";
import type { WikiKind } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const KINDS: WikiKind[] = ["personal", "project", "channel"];

/** GET /api/wikis — 내 위키 목록(Bearer). */
export async function GET(req: Request) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  const wikis = await listWikisForUser(user.id);
  return NextResponse.json(
    {
      wikis: wikis.map((w) => ({
        id: w.id,
        slug: w.slug,
        title: w.title,
        kind: w.kind,
        visibility: w.visibility,
        pages: w._count.pages,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** POST /api/wikis — 위키 생성(Bearer). body: { title, kind?, description? } */
export async function POST(req: Request) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: { title?: string; kind?: string; description?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.title) return NextResponse.json({ error: "title_required" }, { status: 400 });
  const kind = KINDS.includes(body.kind as WikiKind) ? (body.kind as WikiKind) : "personal";
  const wiki = await createWiki(user.id, { title: body.title, kind, description: body.description });
  return NextResponse.json({ id: wiki.id, slug: wiki.slug, title: wiki.title }, { status: 201 });
}
