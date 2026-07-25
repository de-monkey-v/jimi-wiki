"use client";
import { useState } from "react";
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
      className="btn-primary flex items-center gap-2 disabled:bg-stone-500"
    >
      {pending && (
        <span aria-hidden="true" className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent motion-reduce:animate-none" />
      )}
      {pending ? t("submitPending") : t("submit")}
    </button>
  );
}

/** 소스 편입 폼: 제출 즉시 버튼에 진행 표시 → 잡 등록 후 ?run= 배지로 이어진다. */
export function IngestPanel({ wikiSlug }: { wikiSlug: string }) {
  const t = useTranslations("WikisSlugIngestPanel");
  const [allowExternalAi, setAllowExternalAi] = useState(true);
  return (
    <form action={ingestAction} encType="multipart/form-data" className="space-y-4">
      <EmptyState
        asset="ingest-flow"
        title={t("emptyTitle")}
        body={t("emptyBody")}
        compact
      />
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <input type="hidden" name="modelAccess" value={allowExternalAi ? "external" : "internalOnly"} />
      <div>
        <label htmlFor="ingest-url" className="mb-1 block text-sm font-medium text-stone-700">{t("urlLabel")}</label>
        <input
          id="ingest-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder={t("urlPlaceholder")}
          className="field-control"
        />
      </div>
      <div>
        <label htmlFor="ingest-text" className="mb-1 block text-sm font-medium text-stone-700">{t("textLabel")}</label>
        <textarea
          id="ingest-text"
          name="text"
          rows={3}
          autoComplete="off"
          placeholder={t("textPlaceholder")}
          className="field-control text-sm"
        />
      </div>
      <div>
        <label htmlFor="ingest-title" className="mb-1 block text-sm font-medium text-stone-700">{t("titleLabel")}</label>
        <input
          id="ingest-title"
          name="title"
          autoComplete="off"
          placeholder={t("titlePlaceholder")}
          className="field-control"
        />
      </div>
      <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5">
        <label htmlFor="ingest-model-access" className="flex cursor-pointer items-start gap-2.5">
          <input
            id="ingest-model-access"
            type="checkbox"
            checked={allowExternalAi}
            onChange={(event) => setAllowExternalAi(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-stone-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-stone-700">{t("modelAccessLabel")}</span>
            <span className="mt-0.5 block text-xs leading-5 text-stone-500">
              {allowExternalAi ? t("modelAccessHint") : t("internalOnlyHint")}
            </span>
          </span>
        </label>
      </div>
      <div className="space-y-1">
        <label htmlFor="ingest-files" className="block text-sm font-medium text-stone-700">{t("fileLabel")}</label>
        <input
          id="ingest-files"
          type="file"
          name="file"
          multiple
          accept=".pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.zip"
          className="field-control text-sm file:mr-3 file:rounded file:border-0 file:bg-stone-200 file:px-3 file:py-1 file:text-stone-700"
        />
        <p className="text-xs text-stone-500">{t("fileHint")}</p>
      </div>
      <SubmitButton />
    </form>
  );
}
