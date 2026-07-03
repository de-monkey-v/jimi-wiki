import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { createSourceUnique } from "@/lib/ingest";
import { reindexSource } from "@/lib/search";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/sources — 원문 목록(본문 제외). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const sources = await prisma.source.findMany({
    where: { wikiId: gate.wiki.id },
    select: { slug: true, title: true, url: true, ingestedAt: true },
    orderBy: { ingestedAt: "desc" },
  });
  return NextResponse.json({ sources }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/wikis/:id/sources — 원문 저장(AI 무관, 불변). 외부 에이전트가 직접 ingest할 때의 1단계.
 * body: { title, body, url? }. 저장 후 FTS 색인. 노트·파생 페이지는 /pages로 직접 작성한다.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;

  let body: { title?: string; body?: string; url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.title || typeof body.body !== "string" || body.body.trim() === "") {
    return NextResponse.json({ error: "title_and_body_required" }, { status: 400 });
  }

  const source = await createSourceUnique(gate.wiki.id, String(body.title).slice(0, 200), body.url, body.body);
  await reindexSource(gate.wiki.id, { id: source.id, slug: source.slug, body: body.body });
  await prisma.logEntry.create({
    data: { wikiId: gate.wiki.id, kind: "ingest", title: `원문 저장(API) | ${body.title}`, detail: source.slug },
  });
  return NextResponse.json({ slug: source.slug }, { status: 201 });
}
