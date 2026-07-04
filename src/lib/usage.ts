import "server-only";
import { prisma } from "@/lib/db";

/**
 * 사용량 계측(UsageEvent). LLM/임베딩 호출 1건을 이벤트로 남긴다.
 * 원칙: fire-and-forget — 계측 실패가 요청 경로(답변/인제스트)를 죽이면 안 된다.
 * 컨텍스트(userId/apiKeyId/wikiId)는 알 때만 채우는 소프트 참조다.
 */

export type UsageMeta = {
  userId?: string | null;
  apiKeyId?: string | null;
  wikiId?: string | null;
  route?: string | null;
};

export type UsageInput = UsageMeta & {
  kind: "llm" | "embed";
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
};

/** 사용량 이벤트 기록(fire-and-forget). 실패는 삼킨다 — 호출부에서 await하지 말 것. */
export function recordUsage(e: UsageInput): void {
  void prisma.usageEvent
    .create({
      data: {
        kind: e.kind,
        route: e.route ?? "",
        userId: e.userId ?? null,
        apiKeyId: e.apiKeyId ?? null,
        wikiId: e.wikiId ?? null,
        model: e.model ?? null,
        inputTokens: e.inputTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        costUsd: e.costUsd ?? null,
      },
    })
    .catch(() => {});
}

/**
 * 특정 유저의 since 이후 사용량 합산(쿼터/대시보드용).
 * ⚠️ 귀속 주의: userId가 실리는 생성형(kind=llm) 이벤트는 query·ingest·chat·lint-deep이다(일일 쿼터가 이들을 통제).
 * 임베딩(kind=embed: search/reindex/categories-match)은 아직 wikiId만 있고 userId가 없어 이 합산에서 누락된다 —
 * 임베딩은 API 키/primitive 경로라 레이트리밋으로 관리하므로 유저 쿼터엔 무관하지만, 유저별 임베딩 비용까지
 * 집계하려면 embedTexts에 userId를 threading해야 한다. cf. 감사 리포트 finding.
 */
export async function usageSince(
  userId: string,
  since: Date,
): Promise<{ events: number; inputTokens: number; outputTokens: number; costUsd: number }> {
  const agg = await prisma.usageEvent.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    _count: true,
  });
  return {
    events: agg._count,
    inputTokens: agg._sum.inputTokens ?? 0,
    outputTokens: agg._sum.outputTokens ?? 0,
    costUsd: agg._sum.costUsd ?? 0,
  };
}

// 유저별 일일 생성형 토큰 상한(입력+출력 합). env로 재정의 가능. 임베딩(kind=embed)은 제외 —
// 임베딩은 API 키/primitive 경로라 레이트리밋으로 관리하고, 이 쿼터는 세션의 생성형 소비만 통제한다.
export const DAILY_TOKEN_LIMIT = Number(process.env.DAILY_TOKEN_LIMIT ?? 3_000_000);

/** UTC 오늘 자정 이후 이 유저에게 귀속된 생성형(kind=llm) 토큰 합(입력+출력). */
export async function dailyGenerativeTokens(userId: string): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.usageEvent.aggregate({
    where: { userId, kind: "llm", createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
}

/**
 * 일일 생성형 토큰 쿼터 판정. ok=false면 호출부가 429(라우트) 또는 throw(서버액션)로 거부한다.
 * 집계 실패 시 fail-open(ok:true) — 계측 DB 장애가 사람 UI를 막지 않도록.
 */
export async function checkDailyQuota(userId: string): Promise<{ ok: boolean; used: number; limit: number }> {
  try {
    const used = await dailyGenerativeTokens(userId);
    return { ok: used < DAILY_TOKEN_LIMIT, used, limit: DAILY_TOKEN_LIMIT };
  } catch {
    return { ok: true, used: 0, limit: DAILY_TOKEN_LIMIT };
  }
}
