export const WIKI_TOC_WIDTH_STORAGE_KEY = "jimi:wiki-toc-width:v1";
export const DEFAULT_WIKI_TOC_WIDTH = 288;
export const MIN_WIKI_TOC_WIDTH = 224;
export const MAX_WIKI_TOC_WIDTH = 480;
export const MAX_WIKI_TOC_VIEWPORT_RATIO = 0.4;

/** 저장값은 기기별 선호 폭이다. 현재 창의 상한은 렌더 시 따로 적용해 큰 화면 선호를 보존한다. */
export function normalizeWikiTocWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIKI_TOC_WIDTH;
  return Math.min(MAX_WIKI_TOC_WIDTH, Math.max(MIN_WIKI_TOC_WIDTH, Math.round(value)));
}

export function parseStoredWikiTocWidth(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_WIKI_TOC_WIDTH;
  return normalizeWikiTocWidth(Number(raw));
}

/** 본문을 과도하게 누르지 않도록 현재 뷰포트의 40%와 절대 상한 중 작은 폭을 쓴다. */
export function wikiTocViewportMax(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return MAX_WIKI_TOC_WIDTH;
  return Math.max(
    MIN_WIKI_TOC_WIDTH,
    Math.min(MAX_WIKI_TOC_WIDTH, Math.floor(viewportWidth * MAX_WIKI_TOC_VIEWPORT_RATIO)),
  );
}

export function displayedWikiTocWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.min(normalizeWikiTocWidth(preferredWidth), wikiTocViewportMax(viewportWidth));
}
