"use client";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { reindexAction } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("WikisSlugReindexForm");
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-secondary flex items-center gap-2 text-sm disabled:text-stone-400"
    >
      {pending && (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-stone-400 border-t-transparent motion-reduce:animate-none" />
      )}
      {pending ? t("reindexing") : t("reindex")}
    </button>
  );
}

/** 시맨틱 재색인 폼: 임베딩 생성이 수 초~수십 초 걸리므로 진행 표시 필수. */
export function ReindexForm({ wikiSlug }: { wikiSlug: string }) {
  const t = useTranslations("WikisSlugReindexForm");
  return (
    <form action={reindexAction} className="flex items-center gap-3">
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <SubmitButton />
      <span className="text-xs text-stone-400">
        {t("hint")}
      </span>
    </form>
  );
}
