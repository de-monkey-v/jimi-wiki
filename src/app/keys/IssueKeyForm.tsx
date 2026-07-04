"use client";
import { useActionState, useEffect, useState } from "react";
import { issueKeyAction, type IssueKeyState } from "./actions";

export function IssueKeyForm({ wikis }: { wikis: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState<IssueKeyState, FormData>(issueKeyAction, null);
  // 노출을 로컬 state로 제어한다(useActionState는 리셋 setter가 없음).
  const [revealed, setRevealed] = useState<string | null>(null);
  const [seenToken, setSeenToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 새 토큰 발급을 렌더 중 감지해 노출 — effect가 아니라 React의 'prop 변화 시 state 조정' 패턴.
  if (state?.token && state.token !== seenToken) {
    setSeenToken(state.token);
    setRevealed(state.token);
    setCopied(false);
  }

  // 다른 키 작업(폐기 등)이 일어나면 민감한 토큰 잔상을 즉시 지운다 — 새로고침 불필요.
  useEffect(() => {
    const clear = () => setRevealed(null);
    window.addEventListener("apikey:changed", clear);
    return () => window.removeEventListener("apikey:changed", clear);
  }, []);

  const selectCls = "border rounded px-3 py-2 text-sm";
  return (
    <div className="space-y-3">
      {revealed && (
        <div className="border border-emerald-300 bg-emerald-50 rounded-lg p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-emerald-800">
              새 토큰이 발급되었습니다 — 지금 복사하세요. 이 화면을 벗어나면 다시 볼 수 없습니다.
            </p>
            <button
              type="button"
              onClick={() => setRevealed(null)}
              aria-label="토큰 숨기기"
              className="shrink-0 rounded px-1.5 text-sm text-emerald-700 hover:bg-emerald-100 hover:text-emerald-900"
            >
              닫기
            </button>
          </div>
          <code className="mt-2 block break-all text-sm bg-white border rounded px-3 py-2">{revealed}</code>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(revealed).then(() => setCopied(true)).catch(() => {})}
            className="mt-2 rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
          >
            {copied ? "복사됨 ✓" : "복사"}
          </button>
        </div>
      )}
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {/* 새 발급을 시작하면 이전 토큰 잔상을 먼저 지운다(성공 시 새 토큰으로 교체됨). */}
      <form action={action} onSubmit={() => setRevealed(null)} className="flex flex-wrap items-center gap-2 pt-2 border-t">
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
