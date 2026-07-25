"use client";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("WikisSlugSourcesSourceSlugDeleteSourceButton");
  const lines = [
    t("confirmIrreversible"),
    "",
    t("confirmDeletedNotes", {
      titles: noteTitles.length ? noteTitles.join(", ") : t("none"),
    }),
    t("confirmOrphanedKnowledge", {
      titles: derivedTitles.length ? derivedTitles.join(", ") : t("none"),
    }),
    "",
    t("confirmContinue"),
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
        className="btn-danger btn-compact shrink-0"
      >
        {t("deleteButton")}
      </button>
    </form>
  );
}
