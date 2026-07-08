// 4개 로케일 메시지 파일의 키 정합성 검사.
// ko(기준)에 있는 모든 leaf 키가 en/ja/zh에도 있어야 하고, 반대로 잉여 키도 리포트한다.
// CI에서 `pnpm check:i18n` 로 실행 — 누락 키가 있으면 exit 1.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["ko", "en", "ja", "zh"];
const BASE = "ko";

function load(loc) {
  return JSON.parse(readFileSync(join(root, "messages", `${loc}.json`), "utf8"));
}

// 중첩 객체를 "a.b.c" leaf 경로 집합으로 평탄화
function leafPaths(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) leafPaths(v, path, out);
    else out.add(path);
  }
  return out;
}

const data = Object.fromEntries(LOCALES.map((l) => [l, load(l)]));
const base = leafPaths(data[BASE]);

let failed = false;
for (const loc of LOCALES) {
  if (loc === BASE) continue;
  const keys = leafPaths(data[loc]);
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`\n[${loc}] ${missing.length} missing, ${extra.length} extra vs ${BASE}`);
    if (missing.length) console.error("  missing:", missing.slice(0, 40).join(", ") + (missing.length > 40 ? " …" : ""));
    if (extra.length) console.error("  extra:  ", extra.slice(0, 40).join(", ") + (extra.length > 40 ? " …" : ""));
  }
}

if (failed) {
  console.error("\ni18n key check FAILED — 로케일 간 키가 일치하지 않습니다.");
  process.exit(1);
}
console.log(`i18n key check OK — ${base.size} keys × ${LOCALES.length} locales 정합.`);
