import "dotenv/config";
import { prisma } from "../src/lib/db";
import { claimNextIngestRun, runClaimedIngestJob, reapStaleRuns } from "../src/lib/ingest";

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
  while (!stopping) {
    await reapStaleRuns();
    const run = await claimNextIngestRun();
    if (!run) {
      await sleep(pollMs);
      continue;
    }
    console.log(`[worker] ingest ${run.id} wiki=${run.wikiId}`);
    await runClaimedIngestJob(run);
  }
  await prisma.$disconnect();
  console.log("[worker] stopped");
}

main().catch(async (e) => {
  console.error("[worker] fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
