import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RESEARCH_MERMAID_BYTES,
  guardResearchMermaid,
  inspectResearchMarkdown,
  normalizeResearchMermaid,
  safeResearchUrl,
} from "./research-markdown";

test("research citation은 코드 밖 첫 등장 순서로 추출하고 중복을 제거한다", () => {
  const inspected = inspectResearchMarkdown([
    "첫 근거 [@alpha]와 재인용 [@alpha].",
    "`[@inline-code]`",
    "```text",
    "[@fenced-code]",
    "```",
    "두 번째 [@beta].",
  ].join("\n\n"));
  assert.deepEqual(inspected.citationSlugs, ["alpha", "beta"]);
  assert.deepEqual(inspected.invalidCitations, []);
});

test("research citation은 정규화되지 않은 slug를 거부 대상으로 표시한다", () => {
  const inspected = inspectResearchMarkdown("[@UPPER Slug] [@bad!] [@정상-슬러그]");
  assert.deepEqual(inspected.citationSlugs, ["정상-슬러그"]);
  assert.deepEqual(inspected.invalidCitations, ["bad!"]);
});

test("Mermaid init/click/개수/UTF-8 크기를 검사하고 위험 블록은 코드 fallback으로 바꾼다", () => {
  const huge = "가".repeat(Math.floor(MAX_RESEARCH_MERMAID_BYTES / 3) + 1);
  const body = [
    "```mermaid",
    "%%{init: { 'theme': 'dark' }}%%",
    "graph TD; click A \"javascript:alert(1)\"",
    "```",
    "```mermaid",
    huge,
    "```",
  ].join("\n");
  const guarded = guardResearchMermaid(body);
  assert.deepEqual(
    guarded.issues.map((issue) => issue.code),
    [
      "research_mermaid_config_forbidden",
      "research_mermaid_click_forbidden",
      "research_mermaid_too_large",
    ],
  );
  assert.equal((guarded.body.match(/```text/g) ?? []).length, 2);
  assert.equal(guarded.body.includes("javascript:alert(1)"), true, "fallback은 실행하지 않고 원문을 텍스트로 보존한다");

  const tooMany = inspectResearchMarkdown(
    Array.from({ length: 13 }, (_, index) => `\`\`\`mermaid\ngraph TD\nA${index} --> B${index}\n\`\`\``).join("\n"),
  );
  assert.deepEqual(
    tooMany.mermaidIssues.map((issue) => [issue.code, issue.index]),
    [["research_mermaid_too_many", 13]],
  );
});

test("Mermaid 경로 라벨의 선행 slash는 일반 텍스트 라벨로 인용한다", () => {
  const body = [
    "```mermaid",
    "flowchart LR",
    "  C --> F[/workspace / shell]",
    "  F --> G[regular / label]",
    "```",
  ].join("\n");
  const normalized = normalizeResearchMermaid(guardResearchMermaid(body).body);
  assert.match(normalized, /F\["\/workspace \/ shell"\]/);
  assert.match(normalized, /G\[regular \/ label\]/);

  const unsafe = ["```mermaid", "%%{init: { 'theme': 'dark' }}%%", "F[/workspace]", "```"].join("\n");
  assert.match(normalizeResearchMermaid(guardResearchMermaid(unsafe).body), /```text[\s\S]*F\[\/workspace\]/);
});

test("research URL 변환은 안전한 프로토콜과 내부 anchor만 허용한다", () => {
  assert.equal(safeResearchUrl("https://example.com"), "https://example.com");
  assert.equal(safeResearchUrl("#research-evidence-1"), "#research-evidence-1");
  assert.equal(safeResearchUrl("/wikis/personal/page"), "/wikis/personal/page");
  assert.equal(safeResearchUrl("//evil.example/path"), "");
  assert.equal(safeResearchUrl("/\\evil.example/path"), "");
  assert.equal(safeResearchUrl("javascript:alert(1)"), "");
  assert.equal(safeResearchUrl("data:text/html,pwn"), "");
  assert.equal(safeResearchUrl("blob:https://example.com/x"), "");
});
