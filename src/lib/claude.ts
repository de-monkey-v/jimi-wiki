import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ToolSpec, ToolLoopResult, LoopUsage } from "@/lib/gemini";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 사용
  return _client;
}

export function claudeEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Gemini FunctionDeclaration 스키마(Type enum, 대문자) → JSON Schema(소문자 type) 변환 */
function toJsonSchema(s: unknown): Record<string, unknown> {
  if (!s || typeof s !== "object") return { type: "object", properties: {} };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    } else if (k === "items") out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ---------- prompt caching ----------
// 프리픽스 캐시 브레이크포인트를 "마지막 메시지의 마지막 블록"으로 매 턴 옮긴다.
// (system 1개 + 이동식 1개 = 총 2개, 한도 4개 이내. 이전 마커를 지우지 않으면 한도 초과)
type CacheableBlock = { cache_control?: { type: "ephemeral" } | null };
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) delete (b as CacheableBlock).cache_control;
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    (last.content[last.content.length - 1] as CacheableBlock).cache_control = { type: "ephemeral" };
  }
}

function addUsage(acc: LoopUsage, u: Anthropic.Usage): void {
  acc.inputTokens += u.input_tokens;
  acc.outputTokens += u.output_tokens;
  acc.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  acc.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
}

/**
 * Claude용 function-calling 루프 — gemini.ts의 generateWithTools와 동일 계약(ToolSpec/ToolLoopResult).
 * stop_reason이 tool_use가 아닐 때까지 반복(최대 maxTurns). 병렬 tool_use는 결과를 한 user 메시지로 반환.
 */
export async function claudeGenerateWithTools(opts: {
  system: string;
  userPrompt: string;
  tools: ToolSpec[];
  maxTurns?: number;
  model: string;
}): Promise<ToolLoopResult> {
  const handlers = new Map(opts.tools.map((t) => [t.decl.name!, t.handler]));
  const tools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.decl.name!,
    description: t.decl.description ?? "",
    input_schema: toJsonSchema(t.decl.parameters) as Anthropic.Tool.InputSchema,
  }));
  // system은 안정 프리픽스 — 캐시 브레이크포인트 고정 (Sonnet 5 최소 캐시 프리픽스 2048토큰 충족: 실측 ~3.1K)
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: opts.userPrompt }] }];
  const called: string[] = [];
  const usage: LoopUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const maxTurns = opts.maxTurns ?? 12;

  for (let turn = 0; turn < maxTurns; turn++) {
    moveCacheBreakpoint(messages);
    const res = await client().messages.create({
      model: opts.model,
      max_tokens: 16000,
      system,
      tools,
      messages,
    });
    addUsage(usage, res.usage);

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: textOf(res), turns: turn, calls: called, usage };
    }

    messages.push({ role: "assistant", content: res.content });

    // 병렬 tool_use 실행 → 결과 전부를 하나의 user 메시지로
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      called.push(tu.name);
      const h = handlers.get(tu.name);
      let content: string;
      let isError = false;
      try {
        const r = h ? await h((tu.input ?? {}) as Record<string, unknown>) : { error: `unknown function: ${tu.name}` };
        content = JSON.stringify(r);
        isError = !h;
      } catch (e) {
        content = JSON.stringify({ error: (e as Error).message });
        isError = true;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  // maxTurns 도달: 도구 없이 마지막 요약 호출로 마무리(작업물 보존) — gemini.ts와 동일한 정책
  const finalRes = await client().messages.create({
    model: opts.model,
    max_tokens: 16000,
    system,
    messages: [
      ...messages,
      { role: "user", content: "이제 도구 호출을 멈추고, 지금까지 만들고 수정한 페이지를 원문·위키 콘텐츠와 같은 언어로 요약 보고하라." },
    ],
  });
  addUsage(usage, finalRes.usage);
  return { text: textOf(finalRes) || "(요약 없음 · maxTurns 도달)", turns: maxTurns, calls: called, usage };
}
