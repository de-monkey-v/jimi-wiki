/**
 * ChatGPT(Codex) OAuth 스모크 — `pnpm openai:smoke [모델]`.
 *
 * `pnpm openai:login` 으로 로그인한 뒤, OAuth 경로로 실제 GPT 모델이 응답하는지 한 번 호출해 확인한다.
 * server-only 모듈(openai.ts)을 로드하므로 server-only-shim 과 함께 실행한다(package.json 참조).
 */
import "dotenv/config";
import { streamText } from "ai";
import { openaiProvider, openaiEnabled } from "../src/lib/openai";
import { oauthPersonalEnabled, storeExists, storePath } from "../src/lib/openai-oauth";

async function main() {
  // 이 스모크는 GPT-over-OAuth 검증용이므로 GPT 모델을 쓴다(CHAT_MODEL 이 gemini 여도 무시). 인자로 override.
  // codex 백엔드는 stream:true 만 허용 → streamText 사용. 기본값은 내부 에이전트와 같은 Sol 모델.
  const model = process.argv[2] || "gpt-5.6-sol";

  console.log("=== ChatGPT OAuth 스모크 ===");
  console.log("토큰 파일:", storePath(), storeExists() ? "(있음)" : "(없음)");
  console.log("OPENAI_OAUTH_PERSONAL:", process.env.OPENAI_OAUTH_PERSONAL ?? "(미설정)");
  console.log("OAuth 경로 활성:", oauthPersonalEnabled());
  console.log("openaiEnabled:", openaiEnabled());
  console.log("모델:", model, "\n");

  if (!oauthPersonalEnabled()) {
    console.error(
      "OAuth 경로가 비활성입니다. 확인:\n" +
        "  1) `pnpm openai:login` 으로 로그인했는가\n" +
        "  2) .env 에 OPENAI_OAUTH_PERSONAL=1 인가\n" +
        "  3) OPENAI_BASE_URL 이 비어있는가(설정 시 그쪽이 우선)",
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const res = streamText({
    model: openaiProvider(model),
    prompt: "한 문장으로: 지금 어떤 모델이 답하고 있는지 모델명을 말해줘.",
  });
  const text = await res.text;
  const usage = await res.usage;
  const ms = Date.now() - t0;

  console.log("✓ 응답 (" + ms + "ms):");
  console.log(text);
  console.log("\n토큰 usage:", JSON.stringify(usage));
  console.log("\n성공 — OAuth 경로로 GPT 호출이 동작합니다.");
  process.exit(0);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n✗ 실패:", msg);
  console.error(
    "\ncodex 백엔드가 추가 바디 정규화를 요구할 수 있습니다. 401/403 이면 재로그인, " +
      "400/422 면 요청 포맷 문제(openai.ts 의 codexFetch 확장 필요) 가능성이 큽니다.",
  );
  process.exit(1);
});
