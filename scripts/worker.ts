import "dotenv/config";
import { prisma } from "../src/lib/db";
import { claimNextAgentRun, runClaimedIngestJob, reapStaleRuns, type ClaimedAgentRun } from "../src/lib/ingest";
import { refreshConfig } from "../src/lib/model-config";
import { refreshPreferredGptModel } from "../src/lib/model-resolver";
import { notifyIngestComplete } from "../src/lib/telegram-notify";
import { processPendingBlobPurges } from "../src/lib/blob-purge";

const pollMs = Number(process.env.WORKER_POLL_MS ?? 3000);
let stopping = false;

async function shutdown() {
  stopping = true;
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runClaimedAgentJob(run: ClaimedAgentRun): Promise<void> {
  if (run.type === "ingest") {
    await runClaimedIngestJob({
      id: run.id,
      wikiId: run.wikiId,
      userId: run.userId,
      input: run.input,
    });
    await notifyIngestComplete(run.id, run.input.notifyChatId);
    return;
  }

  const buildId = "buildId" in run.input && typeof run.input.buildId === "string" ? run.input.buildId : "";
  try {
    if (!buildId) throw new Error("rebuild run에 buildId가 없습니다");
    const buildModule = await import("../src/lib/builds");
    const execute = (buildModule as unknown as {
      executeKnowledgeBuild?: (id: string) => Promise<unknown>;
    }).executeKnowledgeBuild;
    if (!execute) throw new Error("knowledge build executor가 준비되지 않았습니다");
    await execute(buildId);
    const build = await prisma.knowledgeBuild.findFirst({
      where: { id: buildId, wikiId: run.wikiId, agentRunId: run.id },
      select: { status: true },
    });
    if (!build || !["published", "publishedDegraded", "review"].includes(build.status)) {
      throw new Error(`rebuild가 게시 상태에 도달하지 못했습니다: ${build?.status ?? "missing"}`);
    }
    // executeKnowledgeBuild가 KnowledgeBuild와 AgentRun을 한 lifecycle로 terminal 상태까지 영속화한다.
  } catch (e) {
    const message = (e as Error).message;
    if (buildId) {
      await prisma.knowledgeBuild.updateMany({
        where: { id: buildId, wikiId: run.wikiId, status: { in: ["pending", "running"] } },
        data: { status: "failed", error: message, finishedAt: new Date() },
      }).catch(() => {});
    }
    await prisma.agentRun.updateMany({
      where: { id: run.id, status: "running" },
      data: { status: "error", stage: null, error: message, finishedAt: new Date() },
    });
  }
}

async function main() {
  console.log(`[worker] started pollMs=${pollMs}`);
  // 첫 잡이 env 기본이 아니라 관리자가 저장한 DB 모델을 쓰도록 캐시를 미리 채운다(비치명적).
  await refreshConfig().catch(() => {});
  // OAuth 기본 GPT 모델을 첫 잡 전에 확정한다(콜드스타트 창에서 미검증/env-폴백 모델로 편입하는 것 방지).
  await refreshPreferredGptModel(true).catch(() => {});
  await refreshConfig().catch(() => {}); // 프로브 결과를 캐시에 즉시 반영
  while (!stopping) {
    // 폴링 루프는 일시적 DB/스키마 오류(예: 마이그레이션 진행 중)에 크래시하지 않고 재시도한다.
    try {
      await processPendingBlobPurges();
      await reapStaleRuns();
      const run = await claimNextAgentRun();
      if (!run) {
        await sleep(pollMs);
        continue;
      }
      console.log(`[worker] ${run.type} ${run.id} wiki=${run.wikiId}`);
      await runClaimedAgentJob(run);
    } catch (e) {
      console.error("[worker] 루프 오류(재시도):", (e as Error)?.message);
      await sleep(pollMs);
    }
  }
  await prisma.$disconnect();
  console.log("[worker] stopped");
}

main().catch(async (e) => {
  console.error("[worker] fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
