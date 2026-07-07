import "server-only";
import { prisma } from "@/lib/db";

/**
 * 앱 전역 런타임 설정(모델 선택 + OAuth 활성). DB 단일행 AppConfig 를 소스로,
 * 미설정(null) 항목은 env 로 폴백한다 → DB 가 비면 현행(env) 동작과 동일.
 *
 * 핫패스(예: openai.ts 의 동기 openaiProvider)를 위해 모듈 캐시에서 **동기**로 읽고,
 * TTL(기본 5s) 경과 시 백그라운드로 비동기 갱신한다. web·worker 가 같은 행을 읽으므로
 * 저장하면 양쪽에 반영된다(저장 프로세스는 즉시, 다른 프로세스는 TTL 내).
 */

export interface ResolvedConfig {
  chatModel: string;
  genModel: string;
  ingestModel: string;
  openaiOAuth: boolean;
}

// env 폴백 — 기존 하드코딩 기본값과 동일하게 유지(동작 보존). UI 표시용으로도 export.
export function envModelDefaults(): ResolvedConfig {
  return envDefaults();
}
function envDefaults(): ResolvedConfig {
  return {
    chatModel: process.env.CHAT_MODEL || "gemini-2.5-flash",
    genModel: process.env.GEN_MODEL || "gemini-2.5-flash",
    ingestModel: process.env.INGEST_MODEL || "gemini-3.1-pro-preview",
    openaiOAuth: process.env.OPENAI_OAUTH_PERSONAL === "1",
  };
}

const TTL_MS = 5_000;
const SINGLETON = "singleton";

let cache: ResolvedConfig | null = null;
let loadedAt = 0;
let refreshing: Promise<void> | null = null;

type ConfigRow = {
  chatModel: string | null;
  genModel: string | null;
  ingestModel: string | null;
  openaiOAuth: boolean | null;
};

function resolve(row: ConfigRow | null): ResolvedConfig {
  const env = envDefaults();
  return {
    chatModel: row?.chatModel ?? env.chatModel,
    genModel: row?.genModel ?? env.genModel,
    ingestModel: row?.ingestModel ?? env.ingestModel,
    openaiOAuth: row?.openaiOAuth ?? env.openaiOAuth,
  };
}

/** DB 에서 설정을 읽어 캐시를 갱신한다(중복 호출은 진행 중 Promise 공유). */
export function refreshConfig(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const row = await prisma.appConfig.findUnique({ where: { id: SINGLETON } });
      cache = resolve(row);
      loadedAt = Date.now();
    } catch (e) {
      // DB 일시 오류 시 캐시가 없으면 env 폴백으로 채워 계속 동작하게 한다.
      if (!cache) cache = envDefaults();
      loadedAt = Date.now(); // 실패도 TTL 백오프 적용(매 호출마다 재시도 방지)
      console.warn("[model-config] refresh 실패, 폴백 사용:", (e as Error)?.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** 동기 조회. 캐시 없으면 env 폴백을 즉시 반환하고 백그라운드 로드를 트리거. TTL 지나면 백그라운드 갱신. */
export function getConfigCached(): ResolvedConfig {
  if (!cache) {
    void refreshConfig();
    return envDefaults();
  }
  if (Date.now() - loadedAt > TTL_MS) void refreshConfig();
  return cache;
}

export function chatModel(): string {
  return getConfigCached().chatModel;
}
export function genModel(): string {
  return getConfigCached().genModel;
}
export function ingestModel(): string {
  return getConfigCached().ingestModel;
}
export function openaiOAuthEnabled(): boolean {
  return getConfigCached().openaiOAuth;
}

/** 설정 저장(부분 갱신). 저장 후 로컬 캐시를 즉시 갱신한다. null 을 주면 해당 항목 env 폴백으로 되돌림. */
export async function setModelConfig(patch: Partial<ConfigRow>): Promise<void> {
  // upsert 가 반환한 확정 행으로 캐시를 직접 세팅한다(in-flight refresh 의 pre-write 결과로 덮이지 않도록).
  const row = await prisma.appConfig.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...patch },
    update: patch,
    select: { chatModel: true, genModel: true, ingestModel: true, openaiOAuth: true },
  });
  cache = resolve(row);
  loadedAt = Date.now();
}

/** UI 표시용: DB 에 실제 저장된 원본 행(null=env 폴백 중). effective 값은 getConfigCached 로. */
export async function getRawConfigRow(): Promise<ConfigRow | null> {
  return prisma.appConfig.findUnique({
    where: { id: SINGLETON },
    select: { chatModel: true, genModel: true, ingestModel: true, openaiOAuth: true },
  });
}
