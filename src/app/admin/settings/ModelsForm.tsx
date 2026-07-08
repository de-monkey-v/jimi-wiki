"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ProviderGroup, CatalogModel } from "@/lib/model-catalog";
import type { ResolvedConfig } from "@/lib/model-config";
import { CHAT_PROVIDERS } from "@/lib/provider";
import { updateModelsAction } from "./actions";

const CUSTOM = "__custom__";

type TestState = { loading: boolean; ok?: boolean; msg?: string };

// 셀렉터 옵션에 근거 표시: 컨텍스트·비용·capability.
function modelMeta(m: CatalogModel): string {
  const bits: string[] = [];
  if (m.context) bits.push(`${Math.round(m.context / 1000)}K ctx`);
  if (m.costIn != null && m.costOut != null) bits.push(`$${m.costIn}/$${m.costOut}`);
  if (m.reasoning) bits.push("reasoning");
  if (m.toolCall) bits.push("tools");
  return bits.length ? ` · ${bits.join(" · ")}` : "";
}

function ModelSelect({
  name,
  label,
  hint,
  groups,
  initial,
  envDefault,
}: {
  name: string;
  label: string;
  hint?: string;
  groups: ProviderGroup[];
  initial: string; // DB 저장값(빈 문자열=env 폴백)
  envDefault: string;
}) {
  const t = useTranslations("AdminSettingsModelsForm");
  const listed = groups.some((g) => g.models.some((m) => m.id === initial));
  const [sel, setSel] = useState(initial ? (listed ? initial : CUSTOM) : "");
  const [custom, setCustom] = useState(listed ? "" : initial);
  const [test, setTest] = useState<TestState>({ loading: false });

  const value = sel === CUSTOM ? custom.trim() : sel; // "" = env 폴백

  async function runTest() {
    const model = value || envDefault;
    setTest({ loading: true });
    try {
      const res = await fetch("/api/admin/openai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      setTest({ loading: false, ok: !!data.ok, msg: data.ok ? data.text : data.error });
    } catch (e) {
      setTest({ loading: false, ok: false, msg: (e as Error).message });
    }
  }

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
      <input type="hidden" name={name} value={value} />
      <div className="flex flex-wrap items-center gap-2">
        <select value={sel} onChange={(e) => setSel(e.target.value)} className="border rounded px-3 py-2 text-sm">
          <option value="">{t("envDefaultOption", { env: envDefault })}</option>
          {groups.map((g) => (
            <optgroup key={g.provider} label={g.label + (g.enabled ? "" : t("providerDisabled"))}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id} disabled={!g.enabled}>
                  {m.name}
                  {modelMeta(m)}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>{t("customOption")}</option>
        </select>
        {sel === CUSTOM && (
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder={t("customPlaceholder")}
            className="border rounded px-3 py-2 text-sm w-48"
          />
        )}
        <button type="button" onClick={runTest} disabled={test.loading} className="text-xs border rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50">
          {test.loading ? t("testing") : t("test")}
        </button>
        {test.ok === true && <span className="text-xs text-emerald-600">✓ {test.msg}</span>}
        {test.ok === false && <span className="text-xs text-red-600">✗ {test.msg}</span>}
      </div>
    </div>
  );
}

export function ModelsForm({
  catalog,
  initial,
  envDefaults,
}: {
  catalog: ProviderGroup[];
  initial: { chat: string; gen: string; ingest: string };
  envDefaults: ResolvedConfig;
}) {
  const t = useTranslations("AdminSettingsModelsForm");
  return (
    <form action={updateModelsAction} className="border rounded-lg p-4 space-y-4">
      <div>
        <h2 className="font-semibold">{t("title")}</h2>
        <p className="text-xs text-gray-500">{t("description")}</p>
      </div>
      <ModelSelect key={`chat:${initial.chat}`} name="chatModel" label={t("chatLabel")} groups={catalog.filter((g) => CHAT_PROVIDERS.includes(g.provider))} initial={initial.chat} envDefault={envDefaults.chatModel} />
      <ModelSelect key={`ingest:${initial.ingest}`} name="ingestModel" label="Ingest (INGEST_MODEL)" hint={t("ingestHint")} groups={catalog} initial={initial.ingest} envDefault={envDefaults.ingestModel} />
      <ModelSelect key={`gen:${initial.gen}`} name="genModel" label={t("genLabel")} groups={catalog} initial={initial.gen} envDefault={envDefaults.genModel} />
      <button className="bg-stone-900 text-white rounded px-4 py-2 w-fit">{t("save")}</button>
    </form>
  );
}
