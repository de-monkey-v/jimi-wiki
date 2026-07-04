import { NextResponse } from "next/server";
import { sessionOnlyGate, hasRole } from "@/lib/api-gate";
import { answerQuery } from "@/lib/query";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/wikis/:id/query — 검색+합성 답변. body: { question, save? }. save=true는 editor 이상. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await sessionOnlyGate(id); // 내부 LLM 합성 — 세션 전용, 읽기(질문)는 viewer 허용
  if (!gate.ok) return gate.res;

  let body: { question?: string; save?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.question) return NextResponse.json({ error: "question_required" }, { status: 400 });
  if (body.save && !hasRole(gate.wiki.role, "editor")) {
    return NextResponse.json({ error: "forbidden_save" }, { status: 403 });
  }

  try {
    const result = await answerQuery(gate.wiki.id, body.question, { save: !!body.save, userId: gate.user.id });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
