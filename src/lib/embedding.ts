import "server-only";
import { recordUsage, type UsageMeta } from "@/lib/usage";
import { geminiEmbedTexts } from "@/lib/gemini";
import {
  EMBED_DIM,
  embedModelName,
  embedProvider,
  localEmbedBaseUrl,
  parseTeiEmbedResponse,
  teiEmbedRequest,
  type EmbedTaskType,
} from "@/lib/embed-config";
import { modelPolicyDispatchRemainingMs, modelPolicyDispatchSignal } from "@/lib/model-access";

export { EMBED_DIM } from "@/lib/embed-config";
export type { EmbedTaskType } from "@/lib/embed-config";

// 임베딩 프로바이더 진입점. 검색·색인은 전부 이 파일의 embedTexts 만 호출한다
// (프로바이더 교체가 이 파일 안에서 끝나도록).

const LOCAL_MAX_ITEMS = 32; // TEI --max-client-batch-size 기본값
const LOCAL_TIMEOUT_MS = 120_000;

function l2normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  return v.map((x) => x / n);
}

/** 임베딩을 쓸 수 있는가 = 선택된 프로바이더의 자격증명·엔드포인트가 있는가. */
export function embeddingEnabled(): boolean {
  return embedProvider() === "local" ? !!localEmbedBaseUrl() : !!process.env.GEMINI_API_KEY;
}

/** 진단·표시용(readyz, 로그). 키/URL 자체는 노출하지 않는다. */
export function embeddingStatus(): { provider: string; model: string; dim: number; enabled: boolean } {
  const provider = embedProvider();
  return { provider, model: embedModelName(provider), dim: EMBED_DIM, enabled: embeddingEnabled() };
}

async function localEmbedBatch(texts: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<number[][]> {
  const base = localEmbedBaseUrl();
  if (!base) throw new Error("EMBED_BASE_URL 미설정 — 로컬 임베딩 서버 주소가 필요합니다");
  // 정책 dispatch 신호와 자체 타임아웃을 함께 건다(모델 서버가 멈춰도 워커가 물리지 않도록).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${base}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(teiEmbedRequest(texts)),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`임베딩 서버 오류 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return parseTeiEmbedResponse(await res.json(), texts.length, EMBED_DIM);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function localEmbedTexts(texts: string[], meta?: UsageMeta): Promise<number[][]> {
  const signal = meta?.wikiId ? modelPolicyDispatchSignal(meta.wikiId) : undefined;
  const remaining = meta?.wikiId ? modelPolicyDispatchRemainingMs(meta.wikiId) : undefined;
  const timeoutMs = Math.max(1_000, Math.min(remaining ?? LOCAL_TIMEOUT_MS, LOCAL_TIMEOUT_MS));
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += LOCAL_MAX_ITEMS) {
    const batch = texts.slice(i, i + LOCAL_MAX_ITEMS);
    for (const v of await localEmbedBatch(batch, signal, timeoutMs)) out.push(l2normalize(v));
  }
  return out;
}

/**
 * texts → EMBED_DIM 차원 L2 정규화 벡터.
 * 프로바이더가 로컬이면 자기 GPU(TEI)로, gemini 면 API 로 보낸다. 자격증명/엔드포인트가 없으면 throw
 * (호출부는 embeddingEnabled 로 분기한다).
 *
 * taskType 은 gemini 의 비대칭 임베딩용이다 — bge-m3 는 프리픽스가 필요 없어 로컬 경로에서는 무시된다.
 */
export async function embedTexts(texts: string[], taskType: EmbedTaskType, meta?: UsageMeta): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (embedProvider() !== "local") return geminiEmbedTexts(texts, taskType, meta);

  const vecs = await localEmbedTexts(texts, meta);
  // 로컬 임베딩은 과금이 없지만, 어떤 프로바이더로 얼마나 색인했는지 보이도록 호출량은 기록한다.
  if (meta) recordUsage({ ...meta, kind: "embed", model: embedModelName("local"), inputTokens: null });
  return vecs;
}
