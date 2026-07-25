"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setupAdminAction } from "./actions";
import type { ActionState } from "@/app/login/types";

export default function SetupForm() {
  const t = useTranslations("SetupSetupForm");
  const [state, action, pending] = useActionState<ActionState, FormData>(setupAdminAction, {});
  return (
    <form action={action} className="space-y-3">
      <input name="name" autoComplete="name" aria-label={t("namePlaceholder")} placeholder={t("namePlaceholder")} className="field-control" />
      <input name="email" type="email" required autoComplete="email" spellCheck={false} aria-label="Email" placeholder="admin@example.com" className="field-control" />
      <input name="password" type="password" required minLength={8} autoComplete="new-password" aria-label={t("passwordPlaceholder")} placeholder={t("passwordPlaceholder")} className="field-control" />
      {state.error && <p role="alert" aria-live="polite" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full py-3">
        {pending ? t("creating") : t("createAdmin")}
      </button>
    </form>
  );
}
