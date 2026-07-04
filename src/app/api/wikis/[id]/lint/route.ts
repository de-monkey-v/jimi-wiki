import { NextResponse } from "next/server";
import { apiWikiGate, sessionOnlyGate } from "@/lib/api-gate";
import { lintWiki } from "@/lib/lint";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/wikis/:id/lint — 건강검진(editor). body: { deep?: boolean }
 * 기계 점검(deep 아님): API 키 허용(apiWikiGate).
 * deep=true(agentic 12턴, 내부 LLM 대량 소비): 세션 전용. API 키로 오면 403.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { deep?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* body 없으면 기계 점검만 */
  }

  let wikiId: string;
  let userId: string | null = null;
  if (body?.deep) {
    // deep은 내부 LLM 소비 → 세션 전용. Bearer(API 키) 요청이면 명시적 403.
    const auth = req.headers.get("authorization");
    if (auth && /^Bearer\s/i.test(auth)) {
      return NextResponse.json({ error: "forbidden_deep_requires_session" }, { status: 403 });
    }
    const gate = await sessionOnlyGate(id, { minRole: "editor" });
    if (!gate.ok) return gate.res;
    wikiId = gate.wiki.id;
    userId = gate.user.id; // deep lint 토큰을 일일 쿼터에 귀속
  } else {
    const gate = await apiWikiGate(req, id, { minRole: "editor" });
    if (!gate.ok) return gate.res;
    wikiId = gate.wiki.id;
  }

  try {
    const report = await lintWiki(wikiId, { deep: !!body?.deep, userId });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
