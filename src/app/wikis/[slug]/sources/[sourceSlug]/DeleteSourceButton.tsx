"use client";
import { deleteSourceAction } from "../actions";

/**
 * 원문 삭제 버튼(editor+). 제출 전 confirm으로 영향을 경고한다:
 * 함께 삭제되는 노트 + 남지만 출처를 잃는 정리된 지식.
 */
export function DeleteSourceButton({
  wikiSlug,
  sourceSlug,
  noteTitles,
  derivedTitles,
}: {
  wikiSlug: string;
  sourceSlug: string;
  noteTitles: string[];
  derivedTitles: string[];
}) {
  const lines = [
    "이 원문을 삭제하면 되돌릴 수 없습니다.",
    "",
    `· 함께 삭제되는 노트: ${noteTitles.length ? noteTitles.join(", ") : "없음"}`,
    `· 남지만 이 원문 출처를 잃는 정리된 지식: ${derivedTitles.length ? derivedTitles.join(", ") : "없음"}`,
    "",
    "계속할까요?",
  ];
  return (
    <form
      action={deleteSourceAction}
      onSubmit={(e) => {
        if (!confirm(lines.join("\n"))) e.preventDefault();
      }}
    >
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <input type="hidden" name="sourceSlug" value={sourceSlug} />
      <button
        type="submit"
        className="shrink-0 rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
      >
        원문 삭제
      </button>
    </form>
  );
}
