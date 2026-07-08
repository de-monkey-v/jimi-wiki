import "server-only";
import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type Content,
  type Part,
  type FunctionCall,
} from "@google/genai";
import { recordUsage, type UsageMeta } from "@/lib/usage";
import { genModel, providerUsable } from "@/lib/model-config";
import { DEFAULT_EMBED_MODEL } from "@/lib/model-defaults";
import { providerOf } from "@/lib/provider";

// 임베딩 모델은 env 고정(DB vector 컬럼·HNSW와 결합). 생성 모델(chat/gen/ingest)은 model-config 에서 런타임 조회.
export const EMBED_MODEL = process.env.EMBED_MODEL || DEFAULT_EMBED_MODEL; // 임베딩(검색·색인)
// ⚠️ EMBED_DIM은 DB의 vector(N) 컬럼·HNSW 인덱스와 결합. 바꾸면 스키마 마이그레이션 + 전체 재색인 필요.
export const EMBED_DIM = Number(process.env.EMBED_DIM) || 768;
const EMBED_MAX_ITEMS = 100;
const EMBED_MAX_CHARS = 18_000; // 요청당 총 문자 예산(토큰/배치 상한 회피)

export function geminiEnabled(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

/** 주어진 모델이 실제로 쓸 수 있는지 = provider 자격증명 존재.
 *  알 수 없는 provider 는 false(gemini 폴백 금지). */
export function llmEnabledForModel(model: string): boolean {
  const p = providerOf(model);
  return p ? providerUsable(p) : false;
}

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 미설정");
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

// 지수 백오프 재시도 (일시적 429/503/네트워크)
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const anyE = e as { status?: number; code?: number | string; message?: string };
      const msg = String(anyE?.message ?? "");
      const retryable =
        anyE?.status === 429 ||
        anyE?.status === 503 ||
        anyE?.status === 500 ||
        /\b(429|500|502|503)\b|rate|quota|unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg);
      if (attempt === MAX || !retryable) break;
      const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      console.warn(`[gemini] ${label} 재시도 ${attempt + 1}/${MAX} (${backoff}ms): ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// ---------- 임베딩 ----------
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

function l2normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  return v.map((x) => x / n);
}

// 문자 예산 + 아이템 수 상한으로 배치 분할
function batchByBudget(texts: string[]): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= EMBED_MAX_ITEMS || curChars + t.length > EMBED_MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(t);
    curChars += t.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** texts → 768차원 L2정규화 벡터. 키 없으면 throw(호출부에서 geminiEnabled로 분기). meta 주면 사용량 계측. */
export async function embedTexts(texts: string[], taskType: EmbedTaskType, meta?: UsageMeta): Promise<number[][]> {
  const out: number[][] = [];
  let inTok = 0;
  let haveTok = false;
  for (const chunk of batchByBudget(texts)) {
    const res = await withRetry(
      () =>
        client().models.embedContent({
          model: EMBED_MODEL,
          contents: chunk,
          config: { outputDimensionality: EMBED_DIM, taskType },
        }),
      "embedContent",
    );
    const m = (res as { usageMetadata?: { promptTokenCount?: number } }).usageMetadata;
    if (m?.promptTokenCount != null) {
      inTok += m.promptTokenCount;
      haveTok = true;
    }
    const embs = res.embeddings ?? [];
    if (embs.length !== chunk.length) {
      throw new Error(`임베딩 개수 불일치 ${embs.length}/${chunk.length}`);
    }
    for (const e of embs) {
      if (!e.values) throw new Error("임베딩 values 누락");
      out.push(l2normalize(e.values));
    }
  }
  // 성공 경로에서만 계측(부분 실패 시 throw로 빠져나가 기록 안 함)
  if (meta) recordUsage({ ...meta, kind: "embed", model: EMBED_MODEL, inputTokens: haveTok ? inTok : null });
  return out;
}

/** 도구 없는 단순 텍스트 생성(질의 답변 등). gen 모델에 따라 provider 라우팅. meta 주면 사용량 계측(성공 경로). */
export async function generateText(system: string, prompt: string, meta?: UsageMeta): Promise<string> {
  const model = genModel();
  const provider = providerOf(model);
  // 비-Gemini provider 는 툴 없는 루프로 위임(동일 계약).
  if (provider === "anthropic" || provider === "openai") {
    const loop =
      provider === "anthropic"
        ? await (await import("@/lib/claude")).claudeGenerateWithTools({ system, userPrompt: prompt, tools: [], model })
        : await (await import("@/lib/openai")).openaiGenerateWithTools({ system, userPrompt: prompt, tools: [], model });
    if (meta && loop.usage) {
      recordUsage({ ...meta, kind: "llm", model, inputTokens: loop.usage.inputTokens, outputTokens: loop.usage.outputTokens });
    }
    return loop.text;
  }
  if (provider !== "google") throw new Error(`알 수 없는 모델 provider: ${model}`);
  const res = await withRetry(
    () =>
      client().models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { systemInstruction: system },
      }),
    "generateContent(text)",
  );
  if (meta) {
    const m = res.usageMetadata;
    recordUsage({
      ...meta,
      kind: "llm",
      model,
      inputTokens: m?.promptTokenCount ?? null,
      outputTokens: m?.candidatesTokenCount ?? null,
    });
  }
  return res.text ?? "";
}

// ---------- tool 루프 ----------
export interface ToolSpec {
  decl: FunctionDeclaration;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface ToolLoopResult {
  text: string;
  turns: number;
  calls: string[];
  usage?: LoopUsage;
}

/**
 * 수동 function-calling 루프. functionCalls 없을 때까지 반복(최대 maxTurns). model로 GEN_MODEL 오버라이드 가능.
 * model이 claude-* 면 동일 계약의 Claude 루프(lib/claude.ts)로 위임한다.
 */
export async function generateWithTools(opts: {
  system: string;
  userPrompt: string;
  tools: ToolSpec[];
  maxTurns?: number;
  model?: string;
}): Promise<ToolLoopResult> {
  const model = opts.model ?? genModel();
  const provider = providerOf(model);
  if (provider === "anthropic") {
    const { claudeGenerateWithTools } = await import("@/lib/claude");
    return claudeGenerateWithTools({ ...opts, model });
  }
  if (provider === "openai") {
    const { openaiGenerateWithTools } = await import("@/lib/openai");
    return openaiGenerateWithTools({ ...opts, model });
  }
  if (provider !== "google") throw new Error(`알 수 없는 모델 provider: ${model}`);
  const handlers = new Map(opts.tools.map((t) => [t.decl.name!, t.handler]));
  const contents: Content[] = [{ role: "user", parts: [{ text: opts.userPrompt }] }];
  const called: string[] = [];
  const usage: LoopUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (m?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }) => {
    if (!m) return;
    usage.inputTokens += m.promptTokenCount ?? 0; // Gemini는 캐시분 포함 프롬프트 합계
    usage.outputTokens += m.candidatesTokenCount ?? 0;
    usage.cacheReadTokens += m.cachedContentTokenCount ?? 0; // 암묵 캐시 적중분(참고용)
  };
  const maxTurns = opts.maxTurns ?? 12;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await withRetry(
      () =>
        client().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: opts.system,
            // 빈 tools 면 function calling config 를 걸지 않는다(Gemini 는 선언 없는 config 를 거부).
            ...(opts.tools.length > 0
              ? {
                  tools: [{ functionDeclarations: opts.tools.map((t) => t.decl) }],
                  toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                }
              : {}),
          },
        }),
      "generateContent",
    );
    addUsage(res.usageMetadata);

    const calls: FunctionCall[] | undefined = res.functionCalls;
    if (!calls || calls.length === 0) {
      return { text: res.text ?? "", turns: turn, calls: called, usage };
    }

    // 모델 턴을 먼저 히스토리에 추가 (thoughtSignature 포함, 누락 시 오류)
    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const parts: Part[] = [];
    for (const c of calls) {
      called.push(c.name!);
      const h = handlers.get(c.name!);
      let response: Record<string, unknown>;
      try {
        response = h ? await h((c.args ?? {}) as Record<string, unknown>) : { error: `unknown function: ${c.name}` };
      } catch (e) {
        response = { error: (e as Error).message };
      }
      const fr: Part = { functionResponse: { name: c.name!, response } };
      if (c.id) fr.functionResponse!.id = c.id;
      parts.push(fr);
    }
    contents.push({ role: "user", parts });
  }

  // maxTurns 도달: throw 대신 도구 없이 마지막 요약 호출로 마무리(작업물 보존)
  const finalRes = await withRetry(
    () =>
      client().models.generateContent({
        model,
        contents: [
          ...contents,
          { role: "user", parts: [{ text: "이제 도구 호출을 멈추고, 지금까지 만들고 수정한 페이지를 원문·위키 콘텐츠와 같은 언어로 요약 보고하라." }] },
        ],
        config: { systemInstruction: opts.system },
      }),
    "generateContent(final)",
  );
  addUsage(finalRes.usageMetadata);
  return { text: finalRes.text ?? "(요약 없음 · maxTurns 도달)", turns: maxTurns, calls: called, usage };
}
