import { NextResponse } from "next/server";
import { getApiAuth } from "@/lib/apikey";
import { createWiki, listWikisForUser } from "@/lib/wiki";
import type { WikiKind } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const KINDS: WikiKind[] = ["personal", "project", "channel"];

/**
 * GET /api/wikis — 내 위키 목록(Bearer).
 * 위키로 스코프된 키(key.wikiId)는 그 위키만 보이게 필터 — 다른 위키 메타데이터 열거 차단.
 */
export async function GET(req: Request) {
  const auth = await getApiAuth(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  const { user, key } = auth;
  const all = await listWikisForUser(user.id);
  const wikis = key.wikiId ? all.filter((w) => w.id === key.wikiId) : all;
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

/**
 * POST /api/wikis — 위키 생성(Bearer). body: { title, kind?, description? }
 * 스코프 키(key.wikiId≠null)나 읽기전용 키(maxRole=viewer)는 위키 생성 불가 — 스코프/상한 우회 차단.
 */
export async function POST(req: Request) {
  const auth = await getApiAuth(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  const { user, key } = auth;
  if (key.wikiId || key.maxRole === "viewer") {
    return NextResponse.json({ error: "forbidden_scoped_key" }, { status: 403 });
  }
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
