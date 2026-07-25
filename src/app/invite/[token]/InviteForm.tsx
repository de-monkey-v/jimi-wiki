"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { registerWithInviteAction } from "@/app/login/actions";
import type { ActionState } from "@/app/login/types";

export default function InviteForm({ token, email }: { token: string; email: string }) {
  const t = useTranslations("InviteTokenInviteForm");
  const [state, action, pending] = useActionState<ActionState, FormData>(registerWithInviteAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input name="email" type="email" required autoComplete="email" spellCheck={false} aria-label="Email" defaultValue={email} readOnly={!!email} placeholder="you@example.com" className="field-control" />
      <input name="password" type="password" required minLength={8} autoComplete="new-password" aria-label={t("passwordPlaceholder")} placeholder={t("passwordPlaceholder")} className="field-control" />
      {state.error && <p role="alert" aria-live="polite" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full py-3">
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
