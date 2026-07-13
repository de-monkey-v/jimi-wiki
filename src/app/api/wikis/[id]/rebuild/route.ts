import { NextResponse } from "next/server";
import { sessionOnlyGate } from "@/lib/api-gate";
import { createRebuildRun } from "@/lib/builds";

export const dynamic = "force-dynamic";

/** 전체 재구축은 owner가 명시적으로 시작하는 세션 전용 생성 작업이다. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await sessionOnlyGate(id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  let forceExtraction = false;
  try {
    const body = await req.json().catch(() => ({}));
    forceExtraction = body?.forceExtraction === true;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const result = await createRebuildRun(gate.wiki.id, gate.user.id, { mode: "full", forceExtraction });
  return NextResponse.json(result, { status: 202, headers: { "Cache-Control": "no-store" } });
}
