"use client";
import { useActionState } from "react";
import { registerWithInviteAction } from "@/app/login/actions";
import type { ActionState } from "@/app/login/types";

export default function InviteForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(registerWithInviteAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input name="email" type="email" required defaultValue={email} readOnly={!!email} placeholder="you@example.com" className="w-full border rounded px-3 py-2" />
      <input name="password" type="password" required minLength={8} placeholder="비밀번호(8자 이상)" className="w-full border rounded px-3 py-2" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-lg bg-stone-900 px-4 py-3 text-white hover:bg-stone-800 disabled:opacity-50">
        {pending ? "가입 중…" : "가입하고 시작"}
      </button>
    </form>
  );
}
