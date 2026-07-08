"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { credentialsLoginAction } from "./actions";
import type { ActionState } from "./types";

export default function LoginForm() {
  const t = useTranslations("LoginLoginForm");
  const [state, action, pending] = useActionState<ActionState, FormData>(credentialsLoginAction, {});
  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" required placeholder="you@example.com" className="w-full border rounded px-3 py-2" />
      <input name="password" type="password" required placeholder={t("passwordPlaceholder")} className="w-full border rounded px-3 py-2" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-lg bg-stone-900 px-4 py-3 text-white hover:bg-stone-800 disabled:opacity-50">
        {pending ? t("loggingIn") : t("login")}
      </button>
    </form>
  );
}
