// hover 미리보기용 마크다운 → 평문 발췌. 렌더 파이프라인(unified)을 태우지 않고
// 정규식으로 마커만 벗긴다 — 미리보기는 근사치면 충분하고, 서버 액션 hot path라 가볍게 유지.

const HEAD_SLICE = 4096; // 본문이 커도 앞부분만 처리(발췌는 어차피 서두)

export function markdownExcerpt(body: string, max = 280): string {
  let text = body.slice(0, HEAD_SLICE);
  text = text.replace(/```[\s\S]*?(?:```|$)/g, " "); // 코드펜스(미종결 포함) 제거
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // 이미지
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2"); // [[t|label]] → label
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1"); // [[t]] → t
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // [text](url) → text
  text = text.replace(/^#{1,6}\s+/gm, ""); // 헤딩 마커
  text = text.replace(/^>\s?/gm, ""); // 인용 마커
  text = text.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, ""); // 리스트 마커
  text = text.replace(/`([^`]*)`/g, "$1"); // 인라인 코드는 내용 유지
  text = text
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(^|[\s(\[{'"「『])[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,!?…)\]}:;'"」』])/g, "$1$2"); // 강조(경계 문자 사이만 — 곱셈 등 오탐 방지)
  text = text.replace(/<[^>]+>/g, " "); // 잔여 HTML 태그
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) text = text.slice(0, max).trimEnd() + "…";
  return text;
}
