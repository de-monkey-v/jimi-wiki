import "dotenv/config";
import { spawnSync } from "node:child_process";

const DEV_DATABASE_PORT = "5434";
const DEV_DATABASE_NAME = "/jimi";
const DEV_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function fail(message) {
  console.error(`[dev-db] 거부: ${message}`);
  console.error(
    "[dev-db] .env의 DATABASE_URL을 개발 DB(postgresql://...@127.0.0.1:5434/jimi)로 바꾼 뒤 다시 실행하세요.",
  );
  process.exit(1);
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

// 개발 서버는 3006 고정 — 운영(release checkout의 next start, 포트 3007)과 절대 겹치지 않는다.
// Tailscale Serve가 443→3007을 프록시하므로, dev가 3007을 물면 개발 중 코드가 운영 주소로 노출된다.
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
