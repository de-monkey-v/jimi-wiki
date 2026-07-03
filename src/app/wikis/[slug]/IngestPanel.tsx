"use client";
import { useFormStatus } from "react-dom";
import { ingestAction } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex items-center gap-2 rounded bg-stone-900 px-4 py-2 text-white disabled:bg-stone-500"
    >
      {pending && (
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
      )}
      {pending ? "잡 등록 중…" : "수집"}
    </button>
  );
}

/** 소스 편입 폼: 제출 즉시 버튼에 진행 표시 → 잡 등록 후 ?run= 배지로 이어진다. */
export function IngestPanel({ wikiSlug }: { wikiSlug: string }) {
  return (
    <form action={ingestAction} className="space-y-3 rounded-lg border p-4">
      <h2 className="font-semibold">소스 편입 (Ingest)</h2>
      <p className="text-xs text-gray-400">URL이나 텍스트를 주면 LLM이 읽고 노트·개념 페이지로 정리합니다.</p>
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <input name="url" placeholder="https://…" className="w-full rounded border px-3 py-2" />
      <textarea name="text" rows={3} placeholder="또는 텍스트 직접 붙여넣기" className="w-full rounded border px-3 py-2 text-sm" />
      <input name="title" placeholder="제목(선택)" className="w-full rounded border px-3 py-2" />
      <SubmitButton />
    </form>
  );
}
