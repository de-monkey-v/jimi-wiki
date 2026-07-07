import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-api";
import { pollDeviceToken } from "@/lib/openai-oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.res;
  let body: { deviceAuthId?: string; userCode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.deviceAuthId || !body.userCode) {
    return NextResponse.json({ error: "deviceAuthId·userCode 필요" }, { status: 400 });
  }
  try {
    const result = await pollDeviceToken(body.deviceAuthId, body.userCode);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ status: "error", message: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
