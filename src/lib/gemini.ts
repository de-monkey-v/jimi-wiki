import "server-only";
import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  createPartFromUri,
  type FunctionDeclaration,
  type Content,
  type Part,
  type FunctionCall,
} from "@google/genai";
import { recordUsage, type UsageMeta } from "@/lib/usage";
import { genModel, providerUsable } from "@/lib/model-config";
import { DEFAULT_EMBED_MODEL } from "@/lib/model-defaults";
import { providerOf } from "@/lib/provider";
import {
  modelPolicyDispatchRemainingMs,
  modelPolicyDispatchSignal,
} from "@/lib/model-access";

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
async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(done, ms);
    function cleanup() {
      signal!.removeEventListener("abort", aborted);
    }
    function done() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function aborted() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal!.reason ?? new Error("model dispatch aborted"));
    }
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function withRetry<T>(fn: () => Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
  const MAX = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (e) {
      signal?.throwIfAborted();
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
      await abortableDelay(backoff, signal);
    }
  }
  throw lastErr;
}

function dispatchLease(meta?: UsageMeta): { signal?: AbortSignal; timeout?: number } {
  const wikiId = meta?.wikiId;
  if (!wikiId) return {};
  return {
    signal: modelPolicyDispatchSignal(wikiId),
    timeout: modelPolicyDispatchRemainingMs(wikiId),
  };
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
  const lease = dispatchLease(meta);
  const out: number[][] = [];
  let inTok = 0;
  let haveTok = false;
  for (const chunk of batchByBudget(texts)) {
    const res = await withRetry(
      () =>
        client().models.embedContent({
          model: EMBED_MODEL,
          contents: chunk,
          config: {
            outputDimensionality: EMBED_DIM,
            taskType,
            abortSignal: lease.signal,
            ...(lease.timeout ? { httpOptions: { timeout: lease.timeout } } : {}),
          },
        }),
      "embedContent",
      lease.signal,
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
  const lease = dispatchLease(meta);
  const model = genModel();
  const provider = providerOf(model);
  // 비-Gemini provider 는 툴 없는 루프로 위임(동일 계약).
  if (provider === "anthropic" || provider === "openai") {
    const loop =
      provider === "anthropic"
        ? await (await import("@/lib/claude")).claudeGenerateWithTools({
            system, userPrompt: prompt, tools: [], model, abortSignal: lease.signal,
          })
        : await (await import("@/lib/openai")).openaiGenerateWithTools({
            system, userPrompt: prompt, tools: [], model, abortSignal: lease.signal,
          });
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
        config: {
          systemInstruction: system,
          abortSignal: lease.signal,
          ...(lease.timeout ? { httpOptions: { timeout: lease.timeout } } : {}),
        },
      }),
    "generateContent(text)",
    lease.signal,
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

// ---------- 비전 OCR(이미지 · 스캔 PDF) ----------
// 텍스트 레이어가 없는 이미지/스캔 PDF에서 텍스트를 전사한다. Gemini는 PDF를 페이지 단위로 자체
// 렌더링하므로 스캔 PDF도 래스터화 없이 원본 바이트를 그대로 넣는다. 키 없으면 throw(호출부에서 geminiEnabled 분기).
const VISION_MODEL = process.env.VISION_MODEL || "gemini-2.5-flash";
const VISION_INLINE_MAX = 15 * 1024 * 1024; // 이보다 크면 Files API 경유(inline base64 페이로드 한계 회피)
const VISION_PROMPT =
  "이 파일에 담긴 모든 텍스트를 그대로(verbatim) 전사하라. 요약·설명·해설·묘사를 덧붙이지 말고, 표는 마크다운 표로, 사람이 읽는 순서대로 텍스트만 출력하라. 추출할 텍스트가 전혀 없으면 아무것도 출력하지 마라.";

/** 이미지/PDF 바이트 → 전사 텍스트. 반드시 wiki policy lock 안에서만 호출한다. */
export async function extractTextFromMedia(
  bytes: Buffer,
  mimeType: string,
  meta: UsageMeta & { wikiId: string },
): Promise<string> {
  const lease = dispatchLease(meta);
  const ai = client();
  let part: Part;
  let uploadedName: string | undefined;
  try {
    if (bytes.length <= VISION_INLINE_MAX) {
      part = { inlineData: { mimeType, data: bytes.toString("base64") } };
    } else {
      // Files API: 업로드 후 ACTIVE 될 때까지 폴링(대용량 PDF는 PROCESSING 경유)
      const uploaded = await withRetry(
        () => ai.files.upload({
          file: new Blob([new Uint8Array(bytes)], { type: mimeType }),
          config: {
            mimeType,
            abortSignal: lease.signal,
            ...(lease.timeout ? { httpOptions: { timeout: lease.timeout } } : {}),
          },
        }),
        "files.upload",
        lease.signal,
      );
      uploadedName = uploaded.name;
      let f = uploaded;
      for (let i = 0; i < 30 && f.state === "PROCESSING"; i++) {
        await abortableDelay(1500, lease.signal);
        f = await ai.files.get({
          name: uploadedName!,
          config: {
            abortSignal: lease.signal,
            ...(lease.timeout ? { httpOptions: { timeout: lease.timeout } } : {}),
          },
        });
      }
      if (f.state === "FAILED" || !f.uri || !f.mimeType) throw new Error("파일 업로드 처리 실패(Files API)");
      part = createPartFromUri(f.uri, f.mimeType);
    }
    const res = await withRetry(
      () =>
        client().models.generateContent({
          model: VISION_MODEL,
          contents: [{ role: "user", parts: [part, { text: VISION_PROMPT }] }],
          config: {
            temperature: 0,
            abortSignal: lease.signal,
            ...(lease.timeout ? { httpOptions: { timeout: lease.timeout } } : {}),
          },
        }),
      "extractTextFromMedia",
      lease.signal,
    );
    if (meta) {
      const m = res.usageMetadata;
      recordUsage({ ...meta, kind: "llm", model: VISION_MODEL, inputTokens: m?.promptTokenCount ?? null, outputTokens: m?.candidatesTokenCount ?? null });
    }
    return (res.text ?? "").trim();
  } finally {
    // 업로드본은 최대 48h 잔존(쿼터·민감정보 노출) → 반드시 정리
    // cleanup 장애가 shared advisory lock을 transaction timeout까지 붙들지 않도록 5초로 제한한다.
    if (uploadedName) {
      const cleanupController = new AbortController();
      const forwardLeaseAbort = () => cleanupController.abort(lease.signal?.reason);
      lease.signal?.addEventListener("abort", forwardLeaseAbort, { once: true });
      const cleanupTimer = setTimeout(
        () => cleanupController.abort(new Error("Gemini file cleanup timeout")),
        5_000,
      );
      const cleanup = ai.files.delete({
        name: uploadedName,
        config: {
          abortSignal: cleanupController.signal,
          httpOptions: { timeout: Math.min(5_000, lease.timeout ?? 5_000) },
        },
      }).catch(() => undefined);
      let cleanupRaceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          cleanupRaceTimer = setTimeout(resolve, 5_000);
        }),
      ]);
      if (cleanupRaceTimer) clearTimeout(cleanupRaceTimer);
      clearTimeout(cleanupTimer);
      lease.signal?.removeEventListener("abort", forwardLeaseAbort);
    }
  }
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
// 멀티턴 대화 히스토리(provider 중립). role은 Gemini 규약("user"|"model")에 맞춘다.
export interface LoopMessage {
  role: "user" | "model";
  text: string;
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
  history?: LoopMessage[]; // 이전 대화 턴(선택). 없으면 단발 — 기존 동작 그대로.
  abortSignal?: AbortSignal;
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
  const contents: Content[] = [
    ...(opts.history ?? []).map((h): Content => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: opts.userPrompt }] },
  ];
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
    opts.abortSignal?.throwIfAborted();
    const res = await withRetry(
      () =>
        client().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: opts.system,
            abortSignal: opts.abortSignal,
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
      opts.abortSignal,
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
        opts.abortSignal?.throwIfAborted();
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
        config: { systemInstruction: opts.system, abortSignal: opts.abortSignal },
      }),
    "generateContent(final)",
    opts.abortSignal,
  );
  addUsage(finalRes.usageMetadata);
  return { text: finalRes.text ?? "(요약 없음 · maxTurns 도달)", turns: maxTurns, calls: called, usage };
}
