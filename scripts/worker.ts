import "dotenv/config";
import { prisma } from "../src/lib/db";
import { claimNextIngestRun, runClaimedIngestJob, reapStaleRuns } from "../src/lib/ingest";
import { refreshConfig } from "../src/lib/model-config";

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

async function main() {
  console.log(`[worker] started pollMs=${pollMs}`);
  // 첫 잡이 env 기본이 아니라 관리자가 저장한 DB 모델을 쓰도록 캐시를 미리 채운다(비치명적).
  await refreshConfig().catch(() => {});
  while (!stopping) {
    // 폴링 루프는 일시적 DB/스키마 오류(예: 마이그레이션 진행 중)에 크래시하지 않고 재시도한다.
    try {
      await reapStaleRuns();
      const run = await claimNextIngestRun();
      if (!run) {
        await sleep(pollMs);
        continue;
      }
      console.log(`[worker] ingest ${run.id} wiki=${run.wikiId}`);
      await runClaimedIngestJob(run);
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
