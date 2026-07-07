import "server-only";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import fallback from "./model-catalog.fallback.json";
import { openaiOAuthEnabled } from "@/lib/model-config";
import { storeExists } from "@/lib/openai-oauth";
import type { Provider } from "@/lib/provider";

/**
 * 모델 선택 드롭다운용 카탈로그. models.dev(api.json)에서 provider→모델 목록·메타데이터를 가져와
 * 우리가 지원하는 provider(google/anthropic/openai)로 필터한다.
 * - 디스크 캐시(.model-catalog.cache.json) + ETag/If-None-Match + stale-while-revalidate → 재시작/만료에도
 *   손편집 fallback 으로 추락하지 않고, 설정 페이지 렌더가 네트워크에 블로킹되지 않는다.
 * - context/cost/reasoning/tool_call 메타데이터를 담아 셀렉터에 근거를 표시한다.
 *
 * 주의: ChatGPT 구독(OAuth) 경로는 플랜이 노출하는 모델만 동작(예: gpt-5.5). 최종 확인은 "테스트" 버튼.
 */

export type CatalogModel = {
  id: string;
  name: string;
  context?: number;
  costIn?: number;
  costOut?: number;
  reasoning?: boolean;
  toolCall?: boolean;
};
export type ProviderGroup = {
  provider: Provider;
  label: string;
  enabled: boolean;
  models: CatalogModel[];
};

const SUPPORTED: Provider[] = ["google", "anthropic", "openai"];
const LABEL: Record<Provider, string> = {
  google: "Google Gemini",
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
};
// OAuth 활성 시 openai 그룹에 덧붙이는, 실측으로 확인된 ChatGPT 구독 모델(카탈로그에 없을 수 있음).
const OAUTH_OPENAI: CatalogModel[] = [
  { id: "gpt-5.5", name: "GPT-5.5 (ChatGPT 구독)", reasoning: true, toolCall: true },
  { id: "gpt-5.1", name: "GPT-5.1 (ChatGPT 구독)", reasoning: true, toolCall: true },
];

const TTL_MS = 24 * 60 * 60 * 1000; // 1일
const MODELS_DEV_URL = "https://models.dev/api.json";

type CacheShape = { at: number; etag?: string; groups: Record<string, CatalogModel[]> };
let cache: CacheShape | null = null;
let revalidating: Promise<Record<string, CatalogModel[]>> | null = null;

function cachePath(): string {
  return process.env.MODEL_CATALOG_CACHE || path.join(process.cwd(), ".model-catalog.cache.json");
}
function readDiskCache(): CacheShape | null {
  try {
    if (!existsSync(cachePath())) return null;
    return JSON.parse(readFileSync(cachePath(), "utf8")) as CacheShape;
  } catch {
    return null;
  }
}
function writeDiskCache(c: CacheShape): void {
  try {
    const p = cachePath();
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, p);
  } catch {
    /* 캐시 쓰기는 best-effort */
  }
}

function providerEnabled(p: Provider): boolean {
  if (p === "google") return !!process.env.GEMINI_API_KEY;
  if (p === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  return !!(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || (openaiOAuthEnabled() && storeExists()));
}

// models.dev id 는 "openai/gpt-5-mini" 형태 → 우리 코드가 쓰는 bare id("gpt-5-mini")로.
function bareId(provider: string, id: string): string {
  return id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
}

type ModelsDevModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: { context?: number };
  cost?: { input?: number; output?: number };
};
type ModelsDevProvider = { models?: Record<string, ModelsDevModel> };

function parseModelsDev(json: Record<string, ModelsDevProvider>): Record<string, CatalogModel[]> {
  const out: Record<string, CatalogModel[]> = {};
  for (const p of SUPPORTED) {
    const models = json[p]?.models ?? {};
    out[p] = Object.values(models)
      .map((m) => ({
        id: bareId(p, m.id ?? ""),
        name: m.name ?? bareId(p, m.id ?? ""),
        context: m.limit?.context,
        costIn: m.cost?.input,
        costOut: m.cost?.output,
        reasoning: m.reasoning,
        toolCall: m.tool_call,
      }))
      .filter((m) => m.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

// 실제 네트워크 재검증(ETag 조건부). 진행 중 호출은 하나를 공유.
function revalidate(): Promise<Record<string, CatalogModel[]>> {
  if (revalidating) return revalidating;
  revalidating = (async () => {
    try {
      const etag = cache?.etag;
      const res = await fetch(MODELS_DEV_URL, {
        headers: etag ? { "If-None-Match": etag } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 304 && cache) {
        cache = { ...cache, at: Date.now() };
        writeDiskCache(cache);
        return cache.groups;
      }
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const groups = parseModelsDev(await res.json());
      cache = { at: Date.now(), etag: res.headers.get("etag") ?? undefined, groups };
      writeDiskCache(cache);
      return groups;
    } catch (e) {
      console.warn("[model-catalog] models.dev 실패, 캐시/폴백 사용:", (e as Error)?.message);
      if (cache) return cache.groups;
      return fallback as Record<string, CatalogModel[]>;
    } finally {
      revalidating = null;
    }
  })();
  return revalidating;
}

async function loadGroups(): Promise<Record<string, CatalogModel[]>> {
  if (!cache) cache = readDiskCache(); // 부팅 직후 디스크에서 복원
  if (cache && Date.now() - cache.at < TTL_MS) return cache.groups; // 신선
  if (cache) {
    void revalidate(); // stale-while-revalidate: stale 즉시 반환 + 백그라운드 갱신
    return cache.groups;
  }
  return revalidate(); // 콜드: 페치(또는 폴백)까지 대기
}

/** provider 그룹 목록. 저장된 값이 목록에 없을 수 있으니 UI 는 custom 입력도 허용해야 한다. */
export async function getModelCatalog(): Promise<ProviderGroup[]> {
  const groups = await loadGroups();
  const oauth = openaiOAuthEnabled() && storeExists() && !process.env.OPENAI_BASE_URL;
  return SUPPORTED.map((provider) => {
    let models = groups[provider] ?? [];
    if (provider === "openai" && oauth) {
      const seen = new Set(models.map((m) => m.id));
      models = [...OAUTH_OPENAI.filter((m) => !seen.has(m.id)), ...models];
    }
    return { provider, label: LABEL[provider], enabled: providerEnabled(provider), models };
  });
}

/** 강제 새로고침(설정 페이지 "새로고침" 버튼). 메모리·디스크 캐시 모두 무효화. */
export function invalidateCatalog(): void {
  cache = null;
  try {
    const p = cachePath();
    if (existsSync(p)) renameSync(p, `${p}.stale`);
  } catch {
    /* best-effort */
  }
}
