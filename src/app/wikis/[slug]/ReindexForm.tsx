"use client";
import { useFormStatus } from "react-dom";
import { reindexAction } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:text-gray-400"
    >
      {pending && (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-stone-400 border-t-transparent" />
      )}
      {pending ? "재색인 중…" : "시맨틱 재색인"}
    </button>
  );
}

/** 시맨틱 재색인 폼: 임베딩 생성이 수 초~수십 초 걸리므로 진행 표시 필수. */
export function ReindexForm({ wikiSlug }: { wikiSlug: string }) {
  return (
    <form action={reindexAction} className="mt-4 flex items-center gap-3">
      <input type="hidden" name="wikiSlug" value={wikiSlug} />
      <SubmitButton />
      <span className="text-xs text-gray-400">
        수동 저장한 페이지는 FTS만 색인됩니다. 이 버튼으로 임베딩을 채워 시맨틱 검색을 활성화하세요.
      </span>
    </form>
  );
}
