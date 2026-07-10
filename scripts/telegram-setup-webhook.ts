import "dotenv/config";
import { setWebhook } from "../src/lib/telegram";
import { webhookSecret, botToken } from "../src/lib/telegram-config";

// 사용: npm run telegram:webhook <공개-URL-베이스>   (예: https://abcd.ngrok.app)
// <베이스>/api/telegram/webhook 을 텔레그램에 등록한다. 공개 HTTPS URL 필요.
async function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("사용법: npm run telegram:webhook <공개-URL-베이스>  (예: https://abcd.ngrok.app)");
    process.exit(1);
  }
  if (!botToken()) return void console.error("TELEGRAM_BOT_TOKEN 미설정");
  const secret = webhookSecret();
  if (!secret) return void console.error("TELEGRAM_WEBHOOK_SECRET 미설정");
  const url = base.replace(/\/$/, "") + "/api/telegram/webhook";
  await setWebhook(url, secret);
  console.log("웹훅 등록 완료:", url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
