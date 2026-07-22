import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { prisma } from "../src/lib/db";
import { claimNextAgentRun, runClaimedIngestJob, reapStaleRuns, type ClaimedAgentRun } from "../src/lib/ingest";
import {
  refreshConfig,
  providerHasCredential,
  effectiveOpenAITransport,
  chatModel,
  genModel,
  ingestModel,
} from "../src/lib/model-config";
import { refreshPreferredGptModel } from "../src/lib/model-resolver";
import { storeExists } from "../src/lib/openai-oauth";
import { notifyIngestComplete } from "../src/lib/telegram-notify";
import { processPendingBlobPurges } from "../src/lib/blob-purge";
import { purgeExpiredTrash } from "../src/lib/trash";

const pollMs = Number(process.env.WORKER_POLL_MS ?? 3000);
const trashSweepMs = 60 * 60 * 1000;
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

/**
 * 시작 시 "지금 어떤 provider 키로 과금되는지"를 명시적으로 찍는다. 특히 키가 프로젝트 `.env`에서
 * 왔는지 셸/환경에서 왔는지를 구분해 표시한다 — 셸에 export된 개인 키가 무심코 쓰여 과금되는 사고를 막기 위함.
 * (Next/dotenv 표준 우선순위상 셸 env가 `.env`보다 우선하므로, 여기서 그 사실을 눈에 보이게 한다.)
 */
function logProviderStatus(): void {
  const envFile: Record<string, string> = existsSync(".env")
    ? parseDotenv(readFileSync(".env"))
    : {};
  // 활성 process.env 값이 .env 선언값과 같으면 출처=.env, 아니면 셸/환경(경고).
  const source = (name: string): string => {
    const val = process.env[name];
    if (!val) return "";
    return envFile[name] === val ? ".env" : "셸/환경 ⚠️";
  };
  console.log("[worker] LLM provider 상태 — 아래 표시된 키로 과금됩니다:");
  console.log(
    `  google    ${providerHasCredential("google") ? `✓ GEMINI_API_KEY (출처: ${source("GEMINI_API_KEY")})` : "✗ (키 없음)"}`,
  );
  if (providerHasCredential("openai")) {
    const t = effectiveOpenAITransport();
    const detail =
      t === "oauth"
        ? storeExists()
          ? "OAuth(ChatGPT 구독)"
          : "oauth 선택됐지만 토큰 없음"
        : t === "proxy"
          ? `프록시 OPENAI_BASE_URL (출처: ${source("OPENAI_BASE_URL")})`
          : `OPENAI_API_KEY (출처: ${source("OPENAI_API_KEY")})`;
    console.log(`  openai    ✓ ${detail}`);
  } else {
    console.log("  openai    ✗ (자격증명 없음)");
  }
  console.log(
    `  anthropic ${providerHasCredential("anthropic") ? `✓ ANTHROPIC_API_KEY (출처: ${source("ANTHROPIC_API_KEY")})` : "✗ (키 없음)"}`,
  );
  console.log(`  → 사용 모델: chat=${chatModel()}  gen=${genModel()}  ingest=${ingestModel()}`);
}

async function main() {
  console.log(`[worker] started pollMs=${pollMs}`);
  // 첫 잡이 env 기본이 아니라 관리자가 저장한 DB 모델을 쓰도록 캐시를 미리 채운다(비치명적).
  await refreshConfig().catch(() => {});
  // OAuth 기본 GPT 모델을 첫 잡 전에 확정한다(콜드스타트 창에서 미검증/env-폴백 모델로 편입하는 것 방지).
  await refreshPreferredGptModel(true).catch(() => {});
  await refreshConfig().catch(() => {}); // 프로브 결과를 캐시에 즉시 반영
  logProviderStatus();
  let nextTrashSweepAt = 0;
  while (!stopping) {
    // 폴링 루프는 일시적 DB/스키마 오류(예: 마이그레이션 진행 중)에 크래시하지 않고 재시도한다.
    try {
      await processPendingBlobPurges();
      await reapStaleRuns();
      if (Date.now() >= nextTrashSweepAt) {
        const purged = await purgeExpiredTrash();
        if (Object.values(purged).some((count) => count > 0)) console.log("[worker] trash purge", purged);
        nextTrashSweepAt = Date.now() + trashSweepMs;
      }
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
