import "server-only";
import { prisma } from "@/lib/db";
import type { LoopMessage } from "@/lib/gemini";

// 봇 대화 기억(멀티턴) — chatId별 최근 턴을 툴 루프 history로 공급한다.
const DEFAULT_HISTORY_TURNS = 10; // 최근 N턴(user+model 합산)만 컨텍스트에 싣는다(bloat 방지)

/** 최근 대화 턴을 시간순(오래된→최신)으로 반환. LoopMessage 형태로 바로 generateWithTools.history에 전달 가능. */
export async function loadHistory(chatId: string, n = DEFAULT_HISTORY_TURNS): Promise<LoopMessage[]> {
  const rows = await prisma.telegramTurn.findMany({
    where: { chatId },
    orderBy: { createdAt: "desc" },
    take: n,
    select: { role: true, text: true },
  });
  // desc로 최근 N개를 뽑은 뒤 오래된 순으로 뒤집어 대화 순서를 복원.
  return rows
    .reverse()
    .map((r) => ({ role: r.role === "model" ? "model" : "user", text: r.text }));
}

export async function appendTurn(chatId: string, role: "user" | "model", text: string): Promise<void> {
  await prisma.telegramTurn.create({ data: { chatId, role, text } });
}
