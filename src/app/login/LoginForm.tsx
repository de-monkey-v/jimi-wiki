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
      <input name="email" type="email" required autoComplete="email" spellCheck={false} aria-label="Email" placeholder="you@example.com" className="field-control" />
      <input name="password" type="password" required autoComplete="current-password" aria-label={t("passwordPlaceholder")} placeholder={t("passwordPlaceholder")} className="field-control" />
      {state.error && <p role="alert" aria-live="polite" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full py-3">
        {pending ? t("loggingIn") : t("login")}
      </button>
    </form>
  );
}
