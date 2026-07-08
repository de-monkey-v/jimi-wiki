import "server-only";

// HTML → 평문. script/style 제거 후 태그 제거 + 기본 엔티티 복원.
// 웹 본문 추출 실패 시 fallback, docx(mammoth) 변환 결과 정제 등에 공용으로 쓴다.
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// 본문 추출 성공으로 간주할 최소 길이. 이보다 짧으면(동의/페이월 스텁 등) 원시 strip으로 폴백.
export const MIN_ARTICLE_CHARS = 200;
