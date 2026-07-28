import "dotenv/config";
import { spawnSync } from "node:child_process";

const DEV_DATABASE_PORT = "5434";
const DEV_DATABASE_NAME = "/jimi";
const DEV_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEV_DATABASE_CONTAINER = "jimi-wiki-dev-db";
const URL_HINT =
  "[dev-db] .env의 DATABASE_URL을 개발 DB(postgresql://...@127.0.0.1:5434/jimi)로 바꾼 뒤 다시 실행하세요.";

function fail(message, hint = URL_HINT) {
  console.error(`[dev-db] 거부: ${message}`);
  console.error(hint);
  process.exit(1);
}

// 포트 번호만 보는 것으로는 부족하다. 운영 컨테이너가 두 compose 파일 병합 기동으로
// 5433과 5434를 동시에 물면(2026-07 실제 발생) 아래 포트 검사를 그대로 통과하면서
// 개발 명령이 운영 DB에 연결된다. 5434를 실제로 노출한 컨테이너가 개발 컨테이너인지 확인한다.
//
// docker 자체를 조회하지 못하는 환경(미설치·권한 없음)에서는 경고만 남기고 통과시킨다 —
// 그런 환경은 애초에 이 compose 구성을 쓰지 않으므로 오탐으로 개발을 막지 않는다.
function assertDevContainerOwnsPort(port) {
  // timeout: DOCKER_HOST가 불통인 원격을 가리키면 docker ps가 오래 멈춘다.
  // 그 동안 모든 개발 명령이 블로킹되므로, 확인을 포기하는 편이 낫다.
  const probe = spawnSync("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (probe.error || probe.status !== 0) {
    console.warn(`[dev-db] 경고: docker로 ${port} 포트의 소유 컨테이너를 확인하지 못했습니다. 포트 번호만 검증합니다.`);
    return;
  }
  const owners = probe.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (owners.length === 0) {
    // 컨테이너가 아닌 것(호스트 postgres, ssh -L 포워딩 등)이 이 포트를 물고 있을 수 있다.
    // 그것까지 막으면 docker 없이 개발하는 구성을 통째로 거부하게 되므로 경고만 남긴다.
    console.warn(`[dev-db] 경고: ${port} 포트를 노출한 컨테이너가 없습니다. \`pnpm db:up\`으로 개발 DB를 먼저 띄우세요.`);
    return;
  }
  const foreign = owners.filter((name) => name !== DEV_DATABASE_CONTAINER);
  if (foreign.length > 0) {
    fail(
      `${port} 포트를 개발 컨테이너(${DEV_DATABASE_CONTAINER})가 아닌 ${foreign.join(", ")}가 노출하고 있습니다.`,
      "[dev-db] `docker compose --env-file ~/.config/jimi-wiki/app.env -f docker-compose.production.yml up -d --force-recreate db`로 운영 컨테이너를 운영 설정만으로 재기동한 뒤 다시 실행하세요.",
    );
  }
}

const rawDatabaseUrl = process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  fail("DATABASE_URL이 없습니다.");
}

let databaseUrl;
try {
  databaseUrl = new URL(rawDatabaseUrl);
} catch {
  fail("DATABASE_URL이 올바른 URL이 아닙니다.");
}

if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  fail("PostgreSQL URL만 허용합니다.");
}
if (!DEV_DATABASE_HOSTS.has(databaseUrl.hostname)) {
  fail(`개발 loopback host가 아닙니다: ${databaseUrl.hostname}`);
}
if (databaseUrl.port !== DEV_DATABASE_PORT) {
  fail(`개발 DB 포트 ${DEV_DATABASE_PORT}가 아닙니다: ${databaseUrl.port || "(기본 포트)"}`);
}
if (databaseUrl.pathname !== DEV_DATABASE_NAME) {
  fail(`개발 DB 이름 jimi가 아닙니다: ${databaseUrl.pathname.replace(/^\//, "") || "(없음)"}`);
}
assertDevContainerOwnsPort(DEV_DATABASE_PORT);

// 개발 서버는 3006 고정 — 운영(릴리스 아카이브의 next start, 포트 23007)과 절대 겹치지 않는다.
// Tailscale Serve가 443→23007을 프록시하므로, dev가 23007을 물면 개발 중 코드가 운영 주소로 노출된다.
const commands = {
  dev: ["exec", "next", "dev", "-p", "3006"],
  "dev-all": ["exec", "tsx", "scripts/dev-all.ts"],
  migrate: ["exec", "prisma", "migrate", "deploy"],
  "migrate:create": ["exec", "prisma", "migrate", "dev"],
  seed: ["exec", "tsx", "prisma/seed.ts"],
  smoke: ["exec", "tsx", "scripts/smoke.ts"],
  worker: ["exec", "tsx", "scripts/worker.ts"],
};
const commandName = process.argv[2];
const command = commands[commandName];
if (!command) {
  fail(`알 수 없는 명령입니다: ${commandName ?? "(없음)"}`);
}

console.log(`[dev-db] 확인: ${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`);
const childEnv = { ...process.env };
if (["smoke", "worker"].includes(commandName)) {
  childEnv.NODE_OPTIONS = ["-r", "./scripts/server-only-shim.cjs", childEnv.NODE_OPTIONS]
    .filter(Boolean)
    .join(" ");
}
const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", command, {
  env: childEnv,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[dev-db] 명령 실행 실패: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
