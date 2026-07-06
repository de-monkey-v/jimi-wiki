#!/usr/bin/env node
// 정본 규칙(rules/ontology-rules.md) ↔ shipped SKILL(skills/wiki-ingest/) ↔ 코드 상수(ONTOLOGY_RULES_VERSION)
// 세 곳의 version 일치 + 스킬 번들의 references/ontology-rules.md 사본이 정본과 byte-parity 인지 검사. CI에서 실행.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = {};
  if (m) for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: src.slice(m ? m[0].length : 0) };
}

const fail = (msg) => {
  console.error(`✗ rules parity: ${msg}`);
  process.exit(1);
};

// 1) 정본
const rules = frontMatter(read("rules/ontology-rules.md"));
const rulesVersion = rules.fm.version;
const rulesBody = rules.body.trim();
if (!rulesVersion) fail("rules/ontology-rules.md 에 version: 없음");

// 2) SKILL front-matter version + 번들에 vendoring된 규칙 사본
const skill = frontMatter(read("skills/wiki-ingest/SKILL.md"));
const skillVersion = skill.fm.ontology_rules_version;
const vendBody = frontMatter(read("skills/wiki-ingest/references/ontology-rules.md")).body.trim();

// 3) 코드 상수
const onto = read("src/lib/ontology.ts");
const constMatch = onto.match(/ONTOLOGY_RULES_VERSION\s*=\s*(\d+)/);
if (!constMatch) fail("ontology.ts 에 ONTOLOGY_RULES_VERSION 없음");
const codeVersion = constMatch[1];

// 검사
if (!(rulesVersion === skillVersion && skillVersion === codeVersion)) {
  fail(`version 불일치 — rules=${rulesVersion} skill=${skillVersion} code=${codeVersion}`);
}
if (rulesBody !== vendBody) {
  fail("skills/wiki-ingest/references/ontology-rules.md 가 정본 본문과 다름(byte-parity 실패). 정본을 다시 복사하세요: cp rules/ontology-rules.md skills/wiki-ingest/references/ontology-rules.md");
}

console.log(`✓ rules parity OK (version=${rulesVersion}, byte-parity 일치)`);
