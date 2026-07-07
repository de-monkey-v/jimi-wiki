/**
 * ChatGPT(Codex) OAuth 로그인 CLI — `pnpm openai:login`.
 *
 * 개인 ChatGPT Plus/Pro 구독을 이 앱에서 쓰기 위한 로컬 전용 로그인. 브라우저를 열어 인증하고
 * 토큰을 로컬 파일(.openai-oauth.json)에 저장한다. 이후 .env 에 OPENAI_OAUTH_PERSONAL=1 을 켜고
 * CHAT_MODEL/GEN_MODEL/INGEST_MODEL 을 gpt-* 로 지정하면 앱이 ChatGPT 백엔드로 라우팅한다.
 *
 * ⚠️ 개인 self-host 전용. 멀티유저/공개 배포에 쓰지 말 것(ChatGPT 약관).
 */
import "dotenv/config";
import { runBrowserLogin, storePath } from "../src/lib/openai-oauth";

async function main() {
  console.log("ChatGPT(Codex) OAuth 로그인 — 로컬 개인용 전용.");
  console.log("⚠️ 개인 구독을 이 앱 하나에서 쓰기 위한 것입니다. 멀티유저/공개 배포엔 쓰지 마세요.\n");

  const store = await runBrowserLogin();

  console.log(`\n✓ 저장 완료: ${storePath()}`);
  console.log(`  accountId: ${store.accountId ?? "(토큰 클레임에 없음)"}`);
  console.log(`  만료: ${new Date(store.expires).toISOString()} (이후 자동 refresh)`);
  console.log("\n다음: .env 에 `OPENAI_OAUTH_PERSONAL=1` 을 켜고 CHAT_MODEL 등을 gpt-* 로 지정하세요.");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("\n로그인 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
