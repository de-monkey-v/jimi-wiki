import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-api";
import { generateWithTools } from "@/lib/gemini";

export const dynamic = "force-dynamic";

/** 선택한 모델을 실제로 한 번 호출해 사용 가능 여부를 확인한다(저장 전 검증용). */
export async function POST(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.res;
  let body: { model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const model = body.model?.trim();
  if (!model) return NextResponse.json({ error: "model 필요" }, { status: 400 });
  try {
    const r = await generateWithTools({
      system: "너는 테스트 응답기다.",
      userPrompt: "한 단어로 'ok' 라고만 답해.",
      tools: [],
      model,
      maxTurns: 1,
    });
    return NextResponse.json(
      { ok: true, text: (r.text || "(빈 응답)").slice(0, 200) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 300) });
  }
}
