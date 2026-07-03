"use client";
import { useActionState } from "react";
import { issueKeyAction, type IssueKeyState } from "./actions";

export function IssueKeyForm() {
  const [state, action, pending] = useActionState<IssueKeyState, FormData>(issueKeyAction, null);
  return (
    <div className="space-y-3">
      {state?.token && (
        <div className="border border-emerald-300 bg-emerald-50 rounded-lg p-4">
          <p className="text-sm font-semibold text-emerald-800">
            새 토큰이 발급되었습니다 — 지금 복사하세요. 이 화면을 벗어나면 다시 볼 수 없습니다.
          </p>
          <code className="mt-2 block break-all text-sm bg-white border rounded px-3 py-2">{state.token}</code>
        </div>
      )}
      <form action={action} className="flex gap-2 pt-2 border-t">
        <input name="name" placeholder="키 이름 (예: ingest-bot)" className="flex-1 border rounded px-3 py-2 text-sm" />
        <button disabled={pending} className="bg-stone-900 text-white rounded px-3 py-2 text-sm disabled:opacity-50">
          {pending ? "발급 중…" : "발급"}
        </button>
      </form>
    </div>
  );
}
