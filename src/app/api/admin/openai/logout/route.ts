import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-api";
import { logout } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.res;
  logout();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
