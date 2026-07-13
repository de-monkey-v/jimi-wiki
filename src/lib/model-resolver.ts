import "server-only";
import { streamText } from "ai";
import { openaiOAuthProvider } from "@/lib/openai";
import { setOAuthDefaultGptModel } from "@/lib/model-config";
import { OAUTH_OPENAI_PREFERENCE } from "@/lib/model-catalog";

/**
 * OAuth(ChatGPT 구독) 기본 GPT 모델 자동 선택기.
 *
 * "OAuth를 쓸 수 있으면 GPT가 기본"을 실현한다 — 선호목록(model-catalog의 OAUTH_OPENAI_PREFERENCE,
 * 신형→구형)을 위에서부터 실제로 1토큰 생성해 보고, 계정에서 **호출되는 첫 모델**을 골라
 * model-config에 주입한다. 새 모델이 열리면 선호목록 맨 위에 한 줄 추가만으로 자동 승격되고,
 * 안 열렸으면 조용히 다음 후보로 내려간다. 결과는 TTL 동안 캐시하고 백그라운드로만 갱신한다.
 */

const TTL_MS = 60 * 60 * 1000; // 1시간 — 가용 모델은 자주 바뀌지 않는다
let resolvedAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * 선호순에서 `probe`가 통과하는 첫 모델을 고른다(주입식 — 테스트는 가짜 probe, 실사용은 OAuth 프로브).
 * 전부 실패하면 null → 호출부(model-config)가 env 폴백을 쓰게 한다(깨진 GPT로 강제하지 않음).
 */
export async function selectPreferredModel(
  probe: (id: string) => Promise<boolean>,
  models: readonly string[] = OAUTH_OPENAI_PREFERENCE,
): Promise<string | null> {
  for (const id of models) {
    if (await probe(id)) return id;
  }
  return null;
}

/** OAuth로 모델 1토큰 생성을 시도해 호출 가능 여부를 본다. 미가용/오류는 false(던지지 않음). */
export async function probeOAuthModel(id: string): Promise<boolean> {
  let streamError: unknown;
  try {
    const result = streamText({
      model: openaiOAuthProvider(id),
      prompt: "ping",
      maxRetries: 0,
      onError: ({ error }) => {
        streamError = error;
      },
    });
    await result.text;
    if (streamError) throw streamError;
    await result.usage;
    return true;
  } catch {
    return false;
  }
}

/**
 * 선호목록을 프로브해 OAuth 기본 GPT 모델을 확정하고 model-config에 주입한다.
 * TTL(1h) 내면 no-op, force=true면 즉시 재프로브. 동시 호출은 진행 중 Promise를 공유한다.
 * 실패/미가용이면 null을 주입해 model-config가 env 폴백을 쓰게 한다.
 */
export function refreshPreferredGptModel(force = false): Promise<void> {
  if (!force && resolvedAt > 0 && Date.now() - resolvedAt < TTL_MS) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const picked = await selectPreferredModel(probeOAuthModel);
      setOAuthDefaultGptModel(picked);
      resolvedAt = Date.now();
    } catch (e) {
      console.warn("[model-resolver] OAuth 기본 모델 프로브 실패:", (e as Error)?.message);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
