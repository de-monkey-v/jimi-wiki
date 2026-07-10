import "server-only";
import { randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, jsonSchema, stepCountIs } from "ai";
import type { ToolSpec, ToolLoopResult, LoopUsage, LoopMessage } from "@/lib/gemini";
import { CODEX_BASE_URL, getFreshAccess } from "@/lib/openai-oauth";
import { effectiveOpenAITransport, providerHasCredential } from "@/lib/model-config";
import { DEFAULT_OPENAI_MODEL } from "@/lib/model-defaults";

// OpenAI 연결 방식(관리자가 /admin/settings 에서 선택, effectiveOpenAITransport 로 해소):
//  1) apikey — 표준 api.openai.com (OPENAI_API_KEY)
//  2) proxy  — OPENAI_BASE_URL 로 OpenAI-호환 프록시(예: 외부 codex-auth 프록시)
//  3) oauth  — ChatGPT 구독 OAuth 를 codex 백엔드로 직접 태움(`pnpm openai:login` 또는 UI 로그인)
// ⚠️ (2)(3) 은 개인 self-host 전용. 멀티유저/공개 배포에 쓰지 말 것(ChatGPT 약관).

// ChatGPT(Codex) 백엔드는 표준 api.openai.com 이 아니고 요청마다 최신 토큰이 필요하다. custom fetch 로
// 매 요청 Authorization·chatgpt-account-id 헤더를 주입하고, codex 백엔드가 요구하는 store:false 를 강제한다.
const codexFetch = (async (input, init) => {
  const { access, accountId } = await getFreshAccess();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${access}`);
  if (accountId) headers.set("chatgpt-account-id", accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  // codex 백엔드는 인증된 Codex 클라이언트 요청으로 인식해야 모델을 허용한다(originator 누락 시 400).
  headers.set("originator", "codex_cli_rs");
  headers.set("session_id", randomUUID());
  let body = init?.body;
  if (typeof body === "string" && headers.get("content-type")?.includes("application/json")) {
    try {
      body = JSON.stringify({ ...JSON.parse(body), store: false });
      headers.delete("content-length"); // 본문 길이 변경 — stale content-length 로 인한 truncation 방지
    } catch {
      /* JSON 이 아니면 그대로 둔다 */
    }
  }
  return fetch(input, { ...init, headers, body });
}) as typeof fetch;

/** 선택된 연결 방식에 맞는 OpenAI provider 와 OAuth(codex) 여부. */
function client(): { provider: ReturnType<typeof createOpenAI>; oauth: boolean } {
  const t = effectiveOpenAITransport();
  if (t === "oauth") {
    return {
      provider: createOpenAI({ baseURL: CODEX_BASE_URL, apiKey: "chatgpt-oauth", fetch: codexFetch }),
      oauth: true,
    };
  }
  if (t === "proxy") {
    return {
      provider: createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined }),
      oauth: false,
    };
  }
  // apikey — 표준 api.openai.com (baseURL 미지정)
  return { provider: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }), oauth: false };
}

// codex 백엔드는 Responses API 전용이므로 OAuth 경로에선 .responses() 를 강제한다.
function resolveModel(model: string) {
  const { provider, oauth } = client();
  return oauth ? provider.responses(model) : provider(model);
}

export function openaiProvider(model: string) {
  return resolveModel(model);
}

export function openaiEnabled(): boolean {
  return providerHasCredential("openai");
}

/** gpt-5.x / gpt-4.x / o1·o3·o4 등 OpenAI 모델 판별. */
export function isOpenAIModel(model: string): boolean {
  return /^(gpt|o\d)/i.test(model);
}

// gemini FunctionDeclaration(대문자 Type) → JSON schema(소문자 type). claude.ts와 동일 규약.
function toJsonSchema(s: unknown): Record<string, unknown> {
  if (!s || typeof s !== "object") return { type: "object", properties: {} };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toJsonSchema(pv)]),
      );
    } else if (k === "items") out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

/** OpenAI function-calling 루프 — gemini.ts의 generateWithTools와 동일 계약(ToolSpec/ToolLoopResult). */
export async function openaiGenerateWithTools(opts: {
  system: string;
  userPrompt: string;
  tools: ToolSpec[];
  maxTurns?: number;
  model?: string;
  history?: LoopMessage[];
}): Promise<ToolLoopResult> {
  const model = opts.model ?? DEFAULT_OPENAI_MODEL;
  const calls: string[] = [];
  const tools = Object.fromEntries(
    opts.tools.map((t) => [
      t.decl.name!,
      tool({
        description: t.decl.description ?? "",
        inputSchema: jsonSchema(toJsonSchema(t.decl.parameters)),
        execute: async (args) => {
          calls.push(t.decl.name!);
          return t.handler(args as Record<string, unknown>);
        },
      }),
    ]),
  );

  // streamText 사용: ChatGPT(Codex) 백엔드는 stream:true 만 허용한다. 표준 OpenAI API 에도 동일하게 동작하므로
  // 두 경로를 통합한다. 스트림을 끝까지 소비한 뒤 집계된 text/usage/steps 를 읽는다.
  // 대화 히스토리가 있으면 prompt 대신 messages 로 전달(멀티턴). role: model→assistant 매핑.
  const messages = opts.history?.length
    ? [
        ...opts.history.map((h) => ({ role: h.role === "model" ? ("assistant" as const) : ("user" as const), content: h.text })),
        { role: "user" as const, content: opts.userPrompt },
      ]
    : undefined;
  const res = streamText({
    model: resolveModel(model),
    system: opts.system,
    ...(messages ? { messages } : { prompt: opts.userPrompt }),
    tools,
    stopWhen: stepCountIs(opts.maxTurns ?? 12),
  });

  const text = await res.text;
  const u = await res.usage;
  const steps = await res.steps;
  const usage: LoopUsage = {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return { text, turns: steps?.length ?? 1, calls, usage };
}
