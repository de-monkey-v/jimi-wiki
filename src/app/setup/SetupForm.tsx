"use client";
import { useActionState } from "react";
import { setupAdminAction } from "./actions";
import type { ActionState } from "@/app/login/types";

export default function SetupForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(setupAdminAction, {});
  return (
    <form action={action} className="space-y-3">
      <input name="name" placeholder="이름(선택)" className="w-full border rounded px-3 py-2" />
      <input name="email" type="email" required placeholder="admin@example.com" className="w-full border rounded px-3 py-2" />
      <input name="password" type="password" required minLength={8} placeholder="비밀번호(8자 이상)" className="w-full border rounded px-3 py-2" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-lg bg-stone-900 px-4 py-3 text-white hover:bg-stone-800 disabled:opacity-50">
        {pending ? "생성 중…" : "관리자 생성"}
      </button>
    </form>
  );
}
