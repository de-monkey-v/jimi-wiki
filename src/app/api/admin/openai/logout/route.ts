import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-api";
import { SharedCredentialError, logout } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.res;
  try {
    logout();
  } catch (e) {
    // 공유 자격증명(codex CLI 의 auth.json)은 앱이 지우지 않는다 — 거부를 그대로 알린다.
    if (e instanceof SharedCredentialError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw e;
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
