"use client";
import { useState } from "react";
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
          <option value="">기본값 (env: {envDefault})</option>
          {groups.map((g) => (
            <optgroup key={g.provider} label={g.label + (g.enabled ? "" : " (비활성 — 키/OAuth 없음)")}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id} disabled={!g.enabled}>
                  {m.name}
                  {modelMeta(m)}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>직접 입력…</option>
        </select>
        {sel === CUSTOM && (
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="모델 id (예: gpt-5.5)"
            className="border rounded px-3 py-2 text-sm w-48"
          />
        )}
        <button type="button" onClick={runTest} disabled={test.loading} className="text-xs border rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50">
          {test.loading ? "테스트 중…" : "테스트"}
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
  return (
    <form action={updateModelsAction} className="border rounded-lg p-4 space-y-4">
      <div>
        <h2 className="font-semibold">모델 선택</h2>
        <p className="text-xs text-gray-500">
          비워두면(기본값) env 설정을 따릅니다. 저장하면 재시작 없이 반영됩니다(다른 프로세스는 몇 초 내).
          채팅은 Gemini·GPT 만 지원합니다(Claude 는 ingest·query·lint 에서 사용 가능).
        </p>
      </div>
      <ModelSelect key={`chat:${initial.chat}`} name="chatModel" label="채팅 (CHAT_MODEL)" groups={catalog.filter((g) => CHAT_PROVIDERS.includes(g.provider))} initial={initial.chat} envDefault={envDefaults.chatModel} />
      <ModelSelect key={`ingest:${initial.ingest}`} name="ingestModel" label="Ingest (INGEST_MODEL)" hint="원문 편입·큐레이션. 품질 레버리지가 큼." groups={catalog} initial={initial.ingest} envDefault={envDefaults.ingestModel} />
      <ModelSelect key={`gen:${initial.gen}`} name="genModel" label="일반 생성 (GEN_MODEL — query·lint)" groups={catalog} initial={initial.gen} envDefault={envDefaults.genModel} />
      <button className="bg-stone-900 text-white rounded px-4 py-2 w-fit">저장</button>
    </form>
  );
}
