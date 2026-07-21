import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { fetchLinkMeta } from "@/lib/ingest";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// 읽을거리(SavedLink)는 위키 콘텐츠(Page/Source)가 아니라 유저 개인의 read-later 리스트다.
// 따라서 external 모델 스코프(personal 비노출·modelAccess) 규약과 무관하며, 항상 "키 소유 유저"의
// 리스트로만 스코프된다(웹 UI의 saveLinkAction 과 동일 시맨틱 — 멤버면 viewer 로 충분).
// 정식 편입(promote)은 사람이 웹 UI에서 수행한다 — 여기서는 담기·조회만 노출한다.

const BARE_URL = /^https?:\/\/\S+$/i;

/** GET /api/wikis/:id/saved-links — 내(키 소유 유저) 읽을거리 목록. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  const links = await prisma.savedLink.findMany({
    where: { wikiId: gate.wiki.id, userId: gate.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, title: true, description: true, promotedAt: true, createdAt: true },
  });
  return NextResponse.json({ links }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/wikis/:id/saved-links — 링크 담기. body: { url, note? }
 * note 를 주면 자동 추출 설명 대신 그 메모를 쓴다. 같은 URL 이 이미 있으면 새로 만들지 않고
 * 기존 항목을 200 + existing:true 로 돌려준다(에이전트가 순차 재시도해도 중복이 쌓이지 않도록).
 * ⚠️ SavedLink 에 (userId,wikiId,url) 유니크 제약이 없어 이 중복 방지는 조회-후-쓰기다 —
 *    동시 요청이 겹치거나 URL 이 문자열로 다르면(끝슬래시·utm_* 등) 중복 행이 생길 수 있다.
 *    단일 운영자 self-host 전제에서 수용한 한계이며, 엄밀히 막으려면 스키마에 유니크 제약이 필요하다.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;

  let body: { url?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) return NextResponse.json({ error: "url_required" }, { status: 400 });
  if (!BARE_URL.test(url)) return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  const select = { id: true, url: true, title: true, description: true, promotedAt: true, createdAt: true } as const;
  const existing = await prisma.savedLink.findFirst({
    where: { wikiId: gate.wiki.id, userId: gate.user.id, url },
    select,
  });
  if (existing) return NextResponse.json({ link: existing, existing: true });

  // fetchLinkMeta 는 LLM 을 쓰지 않고, SSRF 가드(assertPublicUrl) 실패·죽은 링크·비HTML 이면
  // hostname 폴백을 돌려준다 — 던지지 않으므로 잘 형성된 http(s) URL 이면 저장은 항상 성립한다.
  const meta = await fetchLinkMeta(url);
  const link = await prisma.savedLink.create({
    data: {
      userId: gate.user.id,
      wikiId: gate.wiki.id,
      url,
      title: meta.title,
      description: note ?? meta.description,
    },
    select,
  });
  return NextResponse.json({ link }, { status: 201 });
}
