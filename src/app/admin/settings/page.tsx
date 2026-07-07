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
import { refreshCatalogAction, setProviderEnabledAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminSettings() {
  await requireAdmin();
  await refreshConfig();
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
        <h1 className="text-2xl font-bold">앱 설정</h1>
        <nav className="text-sm text-gray-500 mt-1">
          <a href="/admin/users" className="underline">유저 관리</a> · <span className="text-gray-800">앱 설정</span>
        </nav>
      </div>

      <section className="border rounded-lg p-4 space-y-3">
        <div>
          <h2 className="font-semibold">사용할 Provider (opt-in)</h2>
          <p className="text-xs text-gray-500">
            키가 있어도 <b>여기서 켠 provider 만</b> 모델 선택·사용이 가능합니다(키 존재 ≠ 자동 사용). 쓸 provider 를 켜세요.
          </p>
        </div>
        <ul className="space-y-1">
          {providers.map((s) => (
            <li key={s.provider} className="flex flex-wrap items-center gap-2 border rounded px-3 py-2">
              <span className="min-w-32 flex-1 font-medium">{s.label}</span>
              <span className={`text-xs ${s.hasCredential ? "text-emerald-600" : "text-gray-400"}`}>
                {s.hasCredential ? "키 있음" : "키 없음"}
              </span>
              <span className={`text-xs ${s.enabled ? "text-emerald-600" : "text-gray-400"}`}>
                {s.enabled ? "활성" : "비활성"}
              </span>
              <form action={setProviderEnabledAction}>
                <input type="hidden" name="provider" value={s.provider} />
                <input type="hidden" name="enabled" value={String(!s.enabled)} />
                <button
                  disabled={!s.hasCredential && !s.enabled}
                  className="text-xs underline disabled:cursor-not-allowed disabled:text-gray-300 disabled:no-underline"
                >
                  {s.enabled ? "비활성화" : "활성화"}
                </button>
              </form>
              {!s.hasCredential && !s.enabled && <span className="text-xs text-amber-600">키/OAuth 필요</span>}
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
        <h2 className="font-semibold">임베딩 (읽기전용)</h2>
        <p className="text-sm text-gray-500">
          EMBED_MODEL=<code>{EMBED_MODEL}</code> · EMBED_DIM=<code>{EMBED_DIM}</code>
        </p>
        <p className="text-xs text-amber-600">
          ⚠️ 임베딩 모델·차원은 DB vector 컬럼·HNSW 인덱스와 결합되어 있어 env 로만 변경합니다. 바꾸면 전체 재색인이 필요합니다.
        </p>
      </section>

      <OAuthPanel status={oauthStatus} transport={openaiTransport()} avail={openaiAvail} />

      <form action={refreshCatalogAction}>
        <button className="text-xs underline text-gray-500">모델 목록 새로고침 (models.dev)</button>
      </form>
    </main>
  );
}
