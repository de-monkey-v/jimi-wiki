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
 * ⚠️ 귀속 주의: 현재 userId가 실리는 이벤트는 generateText(query)·ingest·chat뿐이다.
 * 임베딩(search/reindex/categories-match)과 lint-deep 이벤트는 wikiId만 있고 userId가 없어
 * 이 합산에서 누락된다. 유저별 쿼터를 강제하려면 먼저 embedTexts/lintWiki에 userId를 threading하거나
 * 여기서 userId OR (유저 소유 wikiId 집합) 기준으로 집계하도록 고쳐야 한다. cf. 감사 리포트 finding.
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
