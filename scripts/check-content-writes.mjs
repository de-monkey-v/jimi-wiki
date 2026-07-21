#!/usr/bin/env node
/**
 * Page/Source projection은 revision과 같은 transaction에서만 바뀌어야 한다.
 * 이 검사는 새 direct Prisma mutation/raw UPDATE가 content-store 바깥에 생기면 CI를 실패시킨다.
 */
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "prisma/seed.ts"];
const allowed = new Set(["src/lib/content-store.ts"]);
const patterns = [
  String.raw`\b(?:prisma|tx)\.(?:page|source)\.(?:create|update|updateMany|upsert|delete|deleteMany)\b`,
  // String.raw 가 아니다 — 따옴표 클래스에 백틱을 넣으려면 \x60 을 JS 가 해석해야 한다.
  // (String.raw 였을 때는 rg 정규식이 `\"` 를 미지원 이스케이프로 보고 컴파일 자체가 실패했다.)
  "\\b(?:UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+['\"\x60]?(?:Page|Source)['\"\x60]?\\b",
];

const failures = [];
for (const pattern of patterns) {
  const run = spawnSync(
    "rg",
    ["-a", "-n", "--no-heading", "--glob", "*.{ts,tsx,mjs}", "--glob", "!src/generated/**", pattern, ...roots],
    {
    encoding: "utf8",
    },
  );
  if (run.status !== 0 && run.status !== 1) {
    console.error(run.stderr || "rg 실행 실패");
    process.exit(run.status ?? 1);
  }
  for (const line of run.stdout.trim().split("\n").filter(Boolean)) {
    const file = line.slice(0, line.indexOf(":"));
    if (!allowed.has(file)) failures.push(line);
  }
}

if (failures.length) {
  console.error("Page/Source direct write가 content-store 밖에 있습니다:");
  for (const row of failures) console.error(`  ${row}`);
  process.exit(1);
}
console.log("content write boundary OK — projection mutation은 src/lib/content-store.ts에만 존재합니다.");
