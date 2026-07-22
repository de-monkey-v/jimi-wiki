import "server-only";
import { prisma } from "@/lib/db";
import { createIngestRun } from "@/lib/ingest";

export type SavedLinkPromotionResult = {
  runId: string | null;
  status: "pending" | "running" | "done" | "error";
  reused: boolean;
  promotedAt: Date | null;
  legacyPromoted: boolean;
};

export async function promoteSavedLink(
  wikiId: string,
  userId: string,
  linkId: string,
): Promise<SavedLinkPromotionResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'SELECT id FROM "SavedLink" WHERE id=$1 AND "wikiId"=$2 AND "userId"=$3 FOR UPDATE',
      linkId,
      wikiId,
      userId,
    );
    const link = await tx.savedLink.findFirst({
      where: { id: linkId, wikiId, userId },
      select: { id: true, url: true, title: true, promotedAt: true, promotedRunId: true },
    });
    if (!link) throw new Error("saved_link_not_found");
    if (link.promotedRunId) {
      const run = await tx.agentRun.findFirst({
        where: { id: link.promotedRunId, wikiId },
        select: { id: true, status: true, output: true, finishedAt: true },
      });
      if (!run) throw new Error("saved_link_promotion_run_not_found");
      let promotedAt = link.promotedAt;
      let status = run.status;
      // 이전 worker가 지식 publish 직후 terminal/output 기록 전에 중단됐거나, 구 구현에서
      // done과 promotedAt이 갈라진 행은 실제 build provenance와 Source 상태로 복구한다.
      if (!promotedAt || run.status === "pending" || run.status === "running") {
        const build = await tx.knowledgeBuild.findFirst({
          where: {
            agentRunId: run.id,
            wikiId,
            status: { in: ["published", "publishedDegraded", "review"] },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, inputManifest: true },
        });
        const manifest = build?.inputManifest && typeof build.inputManifest === "object" && !Array.isArray(build.inputManifest)
          ? build.inputManifest as Record<string, unknown>
          : {};
        const curateSourceRevisionId = typeof manifest.curateSourceRevisionId === "string"
          ? manifest.curateSourceRevisionId
          : null;
        const targetRevision = curateSourceRevisionId
          ? await tx.sourceRevision.findFirst({
              where: { id: curateSourceRevisionId, source: { wikiId } },
              select: { source: { select: { curationState: true } } },
            })
          : null;
        const publishedTargetDraft = build && curateSourceRevisionId
          ? await tx.knowledgeDraft.count({
              where: {
                buildId: build.id,
                status: { in: ["published", "accepted"] },
                sources: { some: { sourceRevisionId: curateSourceRevisionId } },
              },
            })
          : 0;
        if (build && targetRevision?.source.curationState === "curated" && publishedTargetDraft > 0) {
          promotedAt ??= new Date();
          status = build.status === "publishedDegraded" ? "error" : "done";
          const existingOutput = run.output && typeof run.output === "object" && !Array.isArray(run.output)
            ? run.output
            : {};
          await tx.savedLink.update({ where: { id: link.id }, data: { promotedAt } });
          await tx.agentRun.update({
            where: { id: run.id },
            data: {
              status,
              stage: null,
              output: { ...existingOutput, buildId: build.id, outcome: "curated", published: true },
              error: status === "error" ? "published with degraded derived indexes" : null,
              finishedAt: run.finishedAt ?? promotedAt,
            },
          });
        }
      }
      return {
        runId: run.id,
        status,
        reused: true,
        promotedAt,
        legacyPromoted: false,
      };
    }
    // promotedRunId 도입 전 완료 행은 성공 상태를 유지하고 자동 재편입하지 않는다.
    if (link.promotedAt) {
      return {
        runId: null,
        status: "done",
        reused: true,
        promotedAt: link.promotedAt,
        legacyPromoted: true,
      };
    }
    const run = await createIngestRun(
      wikiId,
      { url: link.url, title: link.title, modelAccess: "external", mode: "curate" },
      userId,
      tx,
    );
    await tx.savedLink.update({ where: { id: link.id }, data: { promotedRunId: run.id } });
    return {
      runId: run.id,
      status: "pending",
      reused: false,
      promotedAt: null,
      legacyPromoted: false,
    };
  });
}
