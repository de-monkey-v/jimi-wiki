import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/admin";
import { EMBED_DIM, embedModelName, embedProvider } from "@/lib/embed-config";
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
    <main className="mx-auto compact-measure space-y-8 px-4 py-12 sm:px-6">
      <header className="page-header">
        <p className="page-kicker">Administration</p>
        <h1 className="page-title">{t("appTitle")}</h1>
        <nav className="mt-2 text-sm text-stone-500">
          <a href="/admin/users" className="ui-link rounded">{t("usersLink")}</a> · <span className="text-stone-800">{t("appTitle")}</span>
        </nav>
      </header>

      <section className="surface-panel space-y-3 p-5">
        <div>
          <h2 className="font-semibold">{t("providersTitle")}</h2>
          <p className="text-xs text-stone-500">{t("providersHint")}</p>
        </div>
        <ul className="space-y-1">
          {providers.map((s) => (
            <li key={s.provider} className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 px-3 py-2">
              <span className="min-w-32 flex-1 font-medium">{s.label}</span>
              <span className={`text-xs ${s.usable ? "text-emerald-600" : "text-stone-400"}`}>
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

      <section className="surface-panel space-y-2 p-5">
        <h2 className="font-semibold">{t("embeddingTitle")}</h2>
        <p className="text-sm text-stone-500">
          EMBED_PROVIDER=<code>{embedProvider()}</code> · EMBED_MODEL=<code>{embedModelName()}</code> ·
          EMBED_DIM=<code>{EMBED_DIM}</code>
        </p>
        <p className="text-xs text-amber-600">
          {t("embeddingWarning")}
        </p>
      </section>

      <OAuthPanel status={oauthStatus} transport={openaiTransport()} avail={openaiAvail} />

      <form action={refreshCatalogAction}>
        <button className="ui-link rounded text-xs">{t("refreshCatalog")}</button>
      </form>
    </main>
  );
}
