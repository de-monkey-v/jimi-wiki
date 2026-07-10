import "server-only";
import { prisma } from "@/lib/db";
import { isTelegramEnabled } from "@/lib/telegram-config";
import { sendMessage } from "@/lib/telegram";

/**
 * 텔레그램 봇 편입 완료 알림. 워커가 잡을 끝낸 직후 호출한다.
 * runId 의 최종 status/output 을 조회해 notifyChatId 로 통지. 예외는 삼킨다(알림 실패가 워커 루프를 깨지 않게).
 */
export async function notifyIngestComplete(runId: string, chatId: string | null | undefined): Promise<void> {
  if (!chatId || !isTelegramEnabled()) return;
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true, output: true, error: true },
    });
    if (!run) return;
    let text: string;
    if (run.status === "done") {
      const out = (run.output ?? {}) as { summary?: string; sourceSlug?: string };
      text = `✅ 편입 완료${out.sourceSlug ? ` (${out.sourceSlug})` : ""}\n${out.summary ?? ""}`.trim();
    } else if (run.status === "error") {
      text = `⚠️ 편입 실패: ${run.error ?? "알 수 없는 오류"}`;
    } else {
      return; // 아직 터미널 상태가 아니면(방어) 알리지 않음
    }
    await sendMessage(chatId, text);
  } catch (e) {
    console.error("[telegram-notify] 알림 실패:", (e as Error)?.message);
  }
}
