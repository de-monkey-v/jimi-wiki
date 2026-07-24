import "dotenv/config";
import { webhookSecret } from "../src/lib/telegram-config";

// 사용: npm run telegram:simulate "<메시지>" <chatId>
//   또는 chatId를 TELEGRAM_TEST_CHAT_ID 로. 공개 URL 없이 로컬 웹훅에 텔레그램 형태 update를 주입한다.
//   봇의 실제 회신은 봇 토큰으로 그 chatId 채팅에 전송되므로, 회신을 보려면 그 채팅이 봇과 대화를 시작한 상태여야 한다.
async function main() {
  const text = process.argv[2];
  const chatId = process.argv[3] ?? process.env.TELEGRAM_TEST_CHAT_ID;
  const base = (process.env.APP_URL ?? "http://localhost:3006").replace(/\/$/, "");
  if (!text || !chatId) {
    console.error('사용법: npm run telegram:simulate "<메시지>" <chatId>  (또는 TELEGRAM_TEST_CHAT_ID)');
    process.exit(1);
  }
  const idNum = Number(chatId);
  const chat = { id: Number.isFinite(idNum) ? idNum : chatId, type: "private" };
  const update = {
    update_id: Date.now(),
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat, from: chat, text },
  };
  const res = await fetch(`${base}/api/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhookSecret() },
    body: JSON.stringify(update),
  });
  console.log("웹훅 응답:", res.status, await res.text());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
