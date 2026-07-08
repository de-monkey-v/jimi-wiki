import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/admin";
import { EMBED_MODEL, EMBED_DIM } from "@/lib/gemini";
import { getModelCatalog, getProviderStatuses } from "@/lib/model-catalog";
import {
  getRawConfigRow,
  refreshConfig,
  envModelDefaults,
  openaiTransport,
  openaiTransportAvailable,
} from "@/lib/model-config";
import { readStoreStatus } from "@/lib/openai-oauth";
import { ModelsForm } from "./ModelsForm";
import { OAuthPanel } from "./OAuthPanel";
import { refreshCatalogAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminSettings() {
  await requireAdmin();
  await refreshConfig();
  const t = await getTranslations("AdminSettingsPage");
  const [catalog, row] = await Promise.all([getModelCatalog(), getRawConfigRow()]);
  const env = envModelDefaults();
  const oauthStatus = readStoreStatus();
  const providers = getProviderStatuses();
  const openaiAvail = {
    apikey: openaiTransportAvailable("apikey"),
    oauth: openaiTransportAvailable("oauth"),
    proxy: openaiTransportAvailable("proxy"),
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 space-y-10">
      <div>
        <h1 className="text-2xl font-bold">{t("appTitle")}</h1>
        <nav className="text-sm text-gray-500 mt-1">
          <a href="/admin/users" className="underline">{t("usersLink")}</a> · <span className="text-gray-800">{t("appTitle")}</span>
        </nav>
      </div>

      <section className="border rounded-lg p-4 space-y-3">
        <div>
          <h2 className="font-semibold">{t("providersTitle")}</h2>
          <p className="text-xs text-gray-500">{t("providersHint")}</p>
        </div>
        <ul className="space-y-1">
          {providers.map((s) => (
            <li key={s.provider} className="flex flex-wrap items-center gap-2 border rounded px-3 py-2">
              <span className="min-w-32 flex-1 font-medium">{s.label}</span>
              <span className={`text-xs ${s.usable ? "text-emerald-600" : "text-gray-400"}`}>
                {s.usable ? t("usable") : t("noCredential")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <ModelsForm
        catalog={catalog}
        initial={{ chat: row?.chatModel ?? "", gen: row?.genModel ?? "", ingest: row?.ingestModel ?? "" }}
        envDefaults={env}
      />

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-semibold">{t("embeddingTitle")}</h2>
        <p className="text-sm text-gray-500">
          EMBED_MODEL=<code>{EMBED_MODEL}</code> · EMBED_DIM=<code>{EMBED_DIM}</code>
        </p>
        <p className="text-xs text-amber-600">
          {t("embeddingWarning")}
        </p>
      </section>

      <OAuthPanel status={oauthStatus} transport={openaiTransport()} avail={openaiAvail} />

      <form action={refreshCatalogAction}>
        <button className="text-xs underline text-gray-500">{t("refreshCatalog")}</button>
      </form>
    </main>
  );
}
