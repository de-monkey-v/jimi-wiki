import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WIKI_TOC_WIDTH,
  MAX_WIKI_TOC_WIDTH,
  MIN_WIKI_TOC_WIDTH,
  displayedWikiTocWidth,
  normalizeWikiTocWidth,
  parseStoredWikiTocWidth,
  wikiTocViewportMax,
} from "./wiki-toc-width";

test("wiki toc 폭은 기본값과 절대 범위 안으로 정규화된다", () => {
  assert.equal(normalizeWikiTocWidth(Number.NaN), DEFAULT_WIKI_TOC_WIDTH);
  assert.equal(normalizeWikiTocWidth(Number.POSITIVE_INFINITY), DEFAULT_WIKI_TOC_WIDTH);
  assert.equal(normalizeWikiTocWidth(100), MIN_WIKI_TOC_WIDTH);
  assert.equal(normalizeWikiTocWidth(352.6), 353);
  assert.equal(normalizeWikiTocWidth(900), MAX_WIKI_TOC_WIDTH);
});

test("wiki toc 저장값은 신규·기존·손상 상태를 안전하게 복원한다", () => {
  assert.equal(parseStoredWikiTocWidth(null), DEFAULT_WIKI_TOC_WIDTH);
  assert.equal(parseStoredWikiTocWidth(""), DEFAULT_WIKI_TOC_WIDTH);
  assert.equal(parseStoredWikiTocWidth("broken"), DEFAULT_WIKI_TOC_WIDTH);
  assert.equal(parseStoredWikiTocWidth("416"), 416);
  assert.equal(parseStoredWikiTocWidth("999"), MAX_WIKI_TOC_WIDTH);
});

test("wiki toc 최대 폭은 본문을 위해 뷰포트 40%와 480px 중 작은 값이다", () => {
  assert.equal(wikiTocViewportMax(768), 307);
  assert.equal(wikiTocViewportMax(1024), 409);
  assert.equal(wikiTocViewportMax(1440), MAX_WIKI_TOC_WIDTH);
  assert.equal(wikiTocViewportMax(Number.NaN), MAX_WIKI_TOC_WIDTH);
});

test("작은 창의 표시 폭만 줄이고 저장된 큰 화면 선호 폭은 바꾸지 않는다", () => {
  const preferred = normalizeWikiTocWidth(460);
  assert.equal(displayedWikiTocWidth(preferred, 800), 320);
  assert.equal(preferred, 460);
  assert.equal(displayedWikiTocWidth(preferred, 1440), 460);
});
