import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { authMode } from "@/lib/auth-mode";
import { inspectTailscaleClaim } from "@/lib/tailscale-auth";
import { claimTailscaleOwnerAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (authMode() !== "tailscale") redirect("/login");
  const [{ error }, state, t] = await Promise.all([
    searchParams,
    inspectTailscaleClaim(),
    getTranslations("ClaimPage"),
  ]);
  if (state.status === "authenticated") redirect("/wikis");

  const stateError = state.status === "claimable" ? null : state.status;
  const errorKey = error ?? stateError;
  const knownErrors = new Set([
    "invalid-config",
    "missing-header",
    "forbidden-login",
    "recovery-required",
    "mapping-conflict",
  ]);
  const safeError = errorKey && knownErrors.has(errorKey) ? errorKey : null;

  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-sm text-stone-600">{t("description")}</p>

      {safeError ? (
        <section className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <h2 className="font-semibold">{t("blockedTitle")}</h2>
          <p className="mt-1">{t(`errors.${safeError}`)}</p>
          {(safeError === "recovery-required" || safeError === "mapping-conflict") && state.status !== "invalid-config" ? (
            <div className="mt-4">
              <p>{t("recoveryHelp")}</p>
              <code className="mt-2 block overflow-x-auto rounded bg-stone-900 p-3 text-xs text-stone-100">
                pnpm tailscale:recover -- --user-id &lt;existing-user-id&gt; --login {"login" in state ? state.login : "$TAILSCALE_ALLOWED_LOGIN"} --confirm ATTACH_TAILSCALE_ACCOUNT
              </code>
            </div>
          ) : null}
        </section>
      ) : state.status === "claimable" ? (
        <section className="mt-6 rounded-lg border border-stone-200 p-5">
          <h2 className="font-semibold">{t("candidateTitle")}</h2>
          <p className="mt-2 text-sm text-stone-600">
            {t("candidate", { email: state.candidate.email, login: state.login })}
          </p>
          <form action={claimTailscaleOwnerAction} className="mt-5">
            <button type="submit" className="rounded bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              {t("claim")}
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
