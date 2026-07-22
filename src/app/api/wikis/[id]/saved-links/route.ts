import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { saveSavedLink } from "@/lib/saved-links";

export const dynamic = "force-dynamic";

const savedLinkSelect = {
  id: true,
  url: true,
  title: true,
  description: true,
  summary: true,
  trashedAt: true,
  purgeAt: true,
  promotedAt: true,
  promotedRunId: true,
  promotedRun: { select: { status: true, error: true } },
  createdAt: true,
} as const;

/** GET /api/wikis/:id/saved-links?state=active|trash|all — 키 소유 유저의 읽을거리. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  const state = new URL(req.url).searchParams.get("state") ?? "active";
  if (!["active", "trash", "all"].includes(state)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  const links = await prisma.savedLink.findMany({
    where: {
      wikiId: gate.wiki.id,
      userId: gate.user.id,
      ...(state === "active" ? { trashedAt: null } : state === "trash" ? { trashedAt: { not: null } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: savedLinkSelect,
  });
  return NextResponse.json({ links, state }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/wikis/:id/saved-links — 링크 담기. body: { url, summary? }.
 * 추적 파라미터를 제거한 URL로 중복을 찾고, 휴지통에 있던 항목이면 복원한다.
 * summary는 호출자가 명시적으로 만든 요약이며 note는 이전 클라이언트 호환 별칭이다.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  let body: { url?: unknown; summary?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body?.url !== "string" || !body.url.trim()) {
    return NextResponse.json({ error: "url_required" }, { status: 400 });
  }

  try {
    const result = await saveSavedLink({
      wikiId: gate.wiki.id,
      userId: gate.user.id,
      url: body.url,
      summary: body.summary ?? body.note,
    });
    return NextResponse.json(result, { status: result.existing ? 200 : 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "save_failed";
    if (["invalid_url", "invalid_summary", "summary_too_large"].includes(code)) {
      return NextResponse.json({ error: code }, { status: 400 });
    }
    throw error;
  }
}
