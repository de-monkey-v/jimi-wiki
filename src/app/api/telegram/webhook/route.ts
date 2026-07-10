import { NextResponse } from "next/server";
import { isTelegramEnabled } from "@/lib/telegram-config";
import { verifyWebhookSecret, parseUpdate } from "@/lib/telegram";
import { handleTelegramUpdate } from "@/lib/telegram-bot";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 에이전트 루프가 수 초 걸릴 수 있음(self-host Node는 무제한)

/**
 * POST /api/telegram/webhook — 텔레그램 봇 업데이트 수신.
 * secret_token 헤더 검증 → update 파싱 → 봇 핸들러(응답은 핸들러가 직접 sendMessage).
 * 처리 예외는 핸들러가 삼키므로 항상 200을 돌려 텔레그램 재전송(중복 처리)을 막는다.
 */
export async function POST(req: Request) {
  if (!isTelegramEnabled()) return NextResponse.json({ error: "telegram_disabled" }, { status: 503 });
  if (!verifyWebhookSecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const msg = parseUpdate(body);
  if (msg) await handleTelegramUpdate(msg); // 텍스트 메시지가 아니면(msg=null) 조용히 무시
  return NextResponse.json({ ok: true });
}
