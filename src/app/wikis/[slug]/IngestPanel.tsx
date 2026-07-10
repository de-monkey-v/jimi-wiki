"use client";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/EmptyState";
import { ingestAction } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("WikisSlugIngestPanel");
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex items-center gap-2 rounded bg-stone-900 px-4 py-2 text-white disabled:bg-stone-500"
    >
      {pending && (
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
      )}
      {pending ? t("submitPending") : t("submit")}
    </button>
  );
}

/** 소스 편입 폼: 제출 즉시 버튼에 진행 표시 → 잡 등록 후 ?run= 배지로 이어진다. */
export function IngestPanel({ wikiSlug }: { wikiSlug: string }) {
  const t = useTranslations("WikisSlugIngestPanel");
  return (
    <form action={ingestAction} encType="multipart/form-data" className="space-y-3 rounded-lg border p-4">
      <EmptyState
        asset="ingest-flow"
        title={t("emptyTitle")}
        body={t("emptyBody")}
        compact
      />
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <input name="url" placeholder={t("urlPlaceholder")} className="w-full rounded border px-3 py-2" />
      <textarea name="text" rows={3} placeholder={t("textPlaceholder")} className="w-full rounded border px-3 py-2 text-sm" />
      <input name="title" placeholder={t("titlePlaceholder")} className="w-full rounded border px-3 py-2" />
      <div className="space-y-1">
        <label className="block text-sm font-medium text-stone-700">{t("fileLabel")}</label>
        <input
          type="file"
          name="file"
          multiple
          accept=".pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.zip"
          className="w-full rounded border px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-stone-200 file:px-3 file:py-1 file:text-stone-700"
        />
        <p className="text-xs text-stone-500">{t("fileHint")}</p>
      </div>
      <SubmitButton />
    </form>
  );
}
