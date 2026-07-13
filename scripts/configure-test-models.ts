/**
 * 검증 환경 모델 고정: ChatGPT OAuth만 허용하고 gpt-5.6 → gpt-5.5 순서로 실제 호출한다.
 * 성공한 첫 모델을 chat/gen/ingest 세 필드에 원자적으로 저장한다.
 */
import "dotenv/config";
import { streamText } from "ai";

function probeErrorMessage(error: unknown): string {
  const value = error as {
    message?: string;
    responseBody?: string;
    lastError?: { message?: string; responseBody?: string };
  };
  const body = value.responseBody ?? value.lastError?.responseBody;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { detail?: string; error?: { message?: string } };
      const detail = parsed.detail ?? parsed.error?.message;
      if (detail) return detail;
    } catch {
      // non-JSON provider body는 일반 message로 축약한다.
    }
  }
  return value.lastError?.message ?? value.message ?? String(error);
}

async function main() {
  // 이 프로세스에서는 API key/proxy 폴백을 의도적으로 제거한다.
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  process.env.OPENAI_OAUTH_PERSONAL = "1";

  const [{ storeExists }, modelConfig, { openaiOAuthProvider }, { prisma }, { OAUTH_OPENAI_PREFERENCE }] = await Promise.all([
    import("../src/lib/openai-oauth"),
    import("../src/lib/model-config"),
    import("../src/lib/openai"),
    import("../src/lib/db"),
    import("../src/lib/model-catalog"),
  ]);
  if (!storeExists()) throw new Error("ChatGPT OAuth store가 없습니다. 먼저 pnpm openai:login을 실행하세요.");

  let selected: string | null = null;
  const errors: string[] = [];
  for (const model of OAUTH_OPENAI_PREFERENCE) {
    let streamError: unknown;
    try {
      const result = streamText({
        // AppConfig를 probe 전에 바꾸지 않는다. 실패하면 기존 설정이 그대로 남고, 이
        // explicit provider가 API key/proxy fallback 없는 OAuth dispatch를 보장한다.
        model: openaiOAuthProvider(model),
        prompt: "Reply with exactly: JIMI_OAUTH_PROBE_OK",
        maxRetries: 0,
        onError: ({ error }) => {
          streamError = error;
        },
      });
      const text = (await result.text).trim();
      if (streamError) throw streamError;
      await result.usage;
      if (!text) throw new Error("빈 응답");
      selected = model;
      break;
    } catch (error) {
      errors.push(`${model}: ${probeErrorMessage(streamError ?? error).slice(0, 240)}`);
    }
  }
  if (!selected) throw new Error(`OAuth 모델 probe 실패\n${errors.join("\n")}`);

  await modelConfig.setModelConfig({
    openaiTransport: "oauth",
    chatModel: selected,
    genModel: selected,
    ingestModel: selected,
  });
  await modelConfig.refreshConfig();
  if (modelConfig.effectiveOpenAITransport() !== "oauth") {
    throw new Error(`검증 transport가 OAuth가 아닙니다: ${modelConfig.effectiveOpenAITransport()}`);
  }
  const row = await prisma.appConfig.findUniqueOrThrow({ where: { id: "singleton" } });
  if (row.openaiTransport !== "oauth" || row.chatModel !== selected || row.genModel !== selected || row.ingestModel !== selected) {
    throw new Error("AppConfig OAuth/model 저장 검증 실패");
  }
  console.log(`OAuth probe 성공: ${selected} (chat/gen/ingest 저장 완료)`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error((error as Error).message);
  const { prisma } = await import("../src/lib/db").catch(() => ({ prisma: null }));
  await prisma?.$disconnect().catch(() => {});
  process.exit(1);
});
