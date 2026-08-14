import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  codeLanguageFromClassName,
  codeTextFromNode,
  ResearchCodePre,
  type ResearchCodeLabels,
} from "../components/research/ResearchCodeBlock";

const labels: ResearchCodeLabels = {
  copy: "복사",
  download: "다운로드",
  showOriginalWidth: "원본 폭으로 보기",
  wrapLongLines: "긴 줄 맞춤",
};

function renderResearchCode(language: string, code: string) {
  return renderToStaticMarkup(
    React.createElement(
      ResearchCodePre,
      {
        labels,
        renderSourceActions: (source: { code: string; language: string }) => React.createElement(
          "button",
          { "data-code": source.code, "data-language": source.language, type: "button" },
          "source action",
        ),
      },
      React.createElement("code", { className: `language-${language}` }, code),
    ),
  );
}

test("research code block은 원문 actions와 PC 기본 줄 맞춤 상태를 렌더한다", () => {
  const html = renderResearchCode("text", "first line\nsecond line");

  assert.match(html, /data-research-code-frame=""/);
  assert.match(html, /data-wrap-mode="auto"/);
  assert.match(html, /data-wrapped="false"/);
  assert.match(html, /data-code="first line\nsecond line"/);
  assert.match(html, /data-language="text"/);
  assert.match(html, /aria-label="긴 줄 맞춤"/);
  assert.match(html, /aria-pressed="false"/);
  assert.equal((html.match(/data-streamdown="code-block-actions"/g) ?? []).length, 1);
});

test("research code pre는 Mermaid를 기존 렌더 경로에 남긴다", () => {
  const html = renderResearchCode("mermaid", "flowchart LR\n  A --> B");

  assert.doesNotMatch(html, /data-research-code-frame/);
  assert.doesNotMatch(html, /긴 줄 맞춤/);
  assert.match(html, /data-block="true"/);
  assert.match(html, /language-mermaid/);
});

test("research code helpers는 중첩된 원문과 language class를 손실 없이 읽는다", () => {
  const nested = React.createElement("span", null, ["alpha\n", React.createElement("b", { key: "b" }, "beta")]);
  assert.equal(codeTextFromNode(nested), "alpha\nbeta");
  assert.equal(codeLanguageFromClassName("foo language-typescript bar"), "typescript");
  assert.equal(codeLanguageFromClassName(undefined), "");
});
