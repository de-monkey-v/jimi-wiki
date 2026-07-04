"use client";
import { useActionState } from "react";
import { issueKeyAction, type IssueKeyState } from "./actions";

export function IssueKeyForm({ wikis }: { wikis: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState<IssueKeyState, FormData>(issueKeyAction, null);
  const selectCls = "border rounded px-3 py-2 text-sm";
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
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <form action={action} className="flex flex-wrap items-center gap-2 pt-2 border-t">
        <input name="name" placeholder="키 이름 (예: ingest-bot)" className="flex-1 min-w-[10rem] border rounded px-3 py-2 text-sm" />
        {/* 스코프 위키: 미선택=전체(레거시). 특정 위키 선택 시 그 위키 콘텐츠 API에서만 유효 */}
        <select name="wikiId" defaultValue="" className={selectCls} title="스코프 위키">
          <option value="">전체 위키</option>
          {wikis.map((w) => (
            <option key={w.id} value={w.id}>{w.title}</option>
          ))}
        </select>
        {/* 상한 역할: 미선택=제한 없음(멤버십 역할 그대로). viewer=읽기 전용, editor=편집 */}
        <select name="maxRole" defaultValue="" className={selectCls} title="상한 역할">
          <option value="">권한 제한 없음</option>
          <option value="viewer">읽기 전용</option>
          <option value="editor">편집</option>
        </select>
        {/* 만료: 미선택=무기한. 선택 시 발급 시점 기준 N일 뒤 만료 */}
        <select name="expiresDays" defaultValue="" className={selectCls} title="만료">
          <option value="">무기한</option>
          <option value="30">30일</option>
          <option value="90">90일</option>
          <option value="365">365일</option>
        </select>
        <button disabled={pending} className="bg-stone-900 text-white rounded px-3 py-2 text-sm disabled:opacity-50">
          {pending ? "발급 중…" : "발급"}
        </button>
      </form>
    </div>
  );
}
