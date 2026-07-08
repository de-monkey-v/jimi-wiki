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
      <input name="name" placeholder={t("namePlaceholder")} className="w-full border rounded px-3 py-2" />
      <input name="email" type="email" required placeholder="admin@example.com" className="w-full border rounded px-3 py-2" />
      <input name="password" type="password" required minLength={8} placeholder={t("passwordPlaceholder")} className="w-full border rounded px-3 py-2" />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-lg bg-stone-900 px-4 py-3 text-white hover:bg-stone-800 disabled:opacity-50">
        {pending ? t("creating") : t("createAdmin")}
      </button>
    </form>
  );
}
