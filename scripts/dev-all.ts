/**
 * web + worker 를 한 프로세스에서 같이 띄운다(의존성 없음). `pnpm dev:all` / `pnpm start:all`.
 * 한쪽이 죽거나 Ctrl-C/SIGTERM 시 둘 다 종료한다. 로그는 [web]/[worker] prefix.
 *
 * 각 child 를 detached(자체 프로세스 그룹)로 띄우고 종료 시 그룹 전체에 시그널을 보내 손자(next/tsx)까지
 * 확실히 죽인다 — 안 그러면 next-dev 손자가 고아로 남아 포트를 계속 점유한다. child 종료코드는 전파한다.
 *
 * 개발 편의용. 운영은 docker-compose(web·worker 별도 서비스)를 권장 — 프로세스 격리·재시작 정책 때문.
 */
import { spawn, type ChildProcess } from "node:child_process";

const webArgs = process.argv[2] === "start" ? ["start"] : ["dev"];
const specs = [
  { name: "web", args: webArgs },
  { name: "worker", args: ["worker"] },
];

const children: ChildProcess[] = [];
let shuttingDown = false;
let exitCode = 0;

function pipe(name: string, data: Buffer) {
  for (const line of data.toString().split("\n")) {
    if (line.length) process.stdout.write(`[${name}] ${line}\n`);
  }
}

function killGroup(c: ChildProcess) {
  if (c.pid == null) return;
  try {
    process.kill(-c.pid, "SIGTERM"); // 음수 pid = 프로세스 그룹 전체
  } catch {
    try {
      c.kill("SIGTERM");
    } catch {
      /* 이미 종료 */
    }
  }
}

function allExited() {
  return children.every((c) => c.exitCode != null || c.signalCode != null);
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev-all] ${reason} → 전체 종료`);
  for (const c of children) killGroup(c);
  const t = setTimeout(() => process.exit(exitCode), 5000);
  const check = () => {
    if (allExited()) {
      clearTimeout(t);
      process.exit(exitCode);
    }
  };
  for (const c of children) c.on("exit", check);
  check();
}

for (const spec of specs) {
  const child = spawn("pnpm", spec.args, { env: process.env, detached: true });
  child.stdout?.on("data", (d: Buffer) => pipe(spec.name, d));
  child.stderr?.on("data", (d: Buffer) => pipe(spec.name, d));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      if (code) exitCode = code;
      shutdown(`${spec.name} 종료(code=${code})`);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
