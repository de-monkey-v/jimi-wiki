import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSlug, extractWikiTargets, renderMarkdown } from "./markdown";

test("normalizeSlug: 소문자화·공백→하이픈·허용외 문자 제거", () => {
  assert.equal(normalizeSlug("Hello World"), "hello-world");
  assert.equal(normalizeSlug("  Spaced  "), "spaced");
  assert.equal(normalizeSlug("under_score-dash"), "under_score-dash");
  assert.equal(normalizeSlug("a/b!c?"), "abc"); // /, !, ? 제거
});

test("normalizeSlug: 한글 슬러그 허용", () => {
  assert.equal(normalizeSlug("제목 슬러그"), "제목-슬러그");
});

test("extractWikiTargets: bare·label·다중·중복", () => {
  assert.deepEqual(extractWikiTargets("[[foo]]"), ["foo"]);
  assert.deepEqual(extractWikiTargets("[[Foo Bar|보이는-라벨]]"), ["foo-bar"]);
  assert.deepEqual(extractWikiTargets("[[a]] 그리고 [[b]]"), ["a", "b"]);
  assert.deepEqual(extractWikiTargets("[[a]] [[a]]"), ["a"]); // Set 중복 제거
});

test("extractWikiTargets: [[slug]](gloss) 링크 충돌 케이스도 타깃 추출 (regression: f09b9fd)", () => {
  assert.deepEqual(extractWikiTargets("설명이 붙은 [[transformer]](어텐션 구조)."), ["transformer"]);
});

test("extractWikiTargets: 코드 영역의 위키링크는 제외", () => {
  assert.deepEqual(extractWikiTargets("인라인 `[[skipme]]` 는 무시"), []);
  assert.deepEqual(extractWikiTargets("```\n[[alsoskip]]\n```"), []);
});

test("renderMarkdown: 위키링크는 wikilink 클래스 앵커로, 없는 타깃은 wikilink-missing", async () => {
  const html = await renderMarkdown("[[foo]] 와 [[bar]]", {
    hrefFor: (t) => `/p/${t}`,
    exists: (t) => t === "foo",
  });
  assert.match(html, /class="wikilink"[^>]*href="\/p\/foo"|href="\/p\/foo"[^>]*class="wikilink"/);
  assert.match(html, /wikilink-missing/); // bar는 미존재
  assert.ok(html.includes("/p/bar"));
});

test("renderMarkdown: sanitize — javascript: href·script 태그 차단", async () => {
  const html = await renderMarkdown("[클릭](javascript:alert(1))\n\n<script>alert(2)</script>", {
    hrefFor: (t) => `/p/${t}`,
  });
  assert.ok(!html.includes("javascript:"), "javascript: href가 남으면 안 됨");
  assert.ok(!html.includes("<script"), "script 태그가 남으면 안 됨");
});
