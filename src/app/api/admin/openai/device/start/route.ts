import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-api";
import { startDeviceAuth } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.res;
  try {
    const device = await startDeviceAuth();
    return NextResponse.json(device, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
