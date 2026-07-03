import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { listPages, upsertPage, getSource, addPageSource } from "@/lib/wiki";
import { reindexEmbeddings } from "@/lib/search";
import { normalizeCategoryForWrite } from "@/lib/governance";
import type { PageKind } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const PAGE_KINDS: PageKind[] = ["note", "concept", "entity", "answer", "meta"];
const coerceKind = (v: unknown): PageKind => (PAGE_KINDS.includes(v as PageKind) ? (v as PageKind) : "note");

/** GET /api/wikis/:id/pages — 페이지 목록. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const pages = await listPages(gate.wiki.id);
  return NextResponse.json({ pages }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/wikis/:id/pages — 페이지 생성/수정(raw, AI 무관).
 * body: { slug?, title, kind, body, embed? }. embed=true면 라우트 레벨에서 reindexEmbeddings 호출.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;

  let body: {
    slug?: string;
    title?: string;
    kind?: string;
    body?: string;
    embed?: boolean;
    category?: string;
    sourceSlug?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !body.title || typeof body.body !== "string") {
    return NextResponse.json({ error: "title_and_body_required" }, { status: 400 });
  }

  const kind = coerceKind(body.kind);
  // S3: raw REST 경로도 거버넌스 우회 못 하게 서버측 정규화. note는 순수성 위해 category 없음.
  const category =
    kind === "note" ? null : body.category ? await normalizeCategoryForWrite(gate.wiki.id, String(body.category)) : undefined;

  // 외부(AI 무관) ingest의 provenance: note는 sourceId 연결, 파생 페이지는 기여(PageContribution) 기록
  let source: { id: string } | null = null;
  if (body.sourceSlug) {
    source = await getSource(gate.wiki.id, String(body.sourceSlug));
    if (!source) return NextResponse.json({ error: "source_not_found" }, { status: 400 });
  }

  const res = await upsertPage(gate.wiki.id, {
    slug: body.slug,
    title: String(body.title),
    kind,
    body: body.body,
    category,
    ...(source && kind === "note" ? { sourceId: source.id } : {}),
  });
  if (source && kind !== "note") await addPageSource(gate.wiki.id, res.slug, source.id);

  let embedded = 0;
  if (body.embed) ({ embedded } = await reindexEmbeddings(gate.wiki.id));

  return NextResponse.json({ ...res, embedded }, { status: res.created ? 201 : 200 });
}
