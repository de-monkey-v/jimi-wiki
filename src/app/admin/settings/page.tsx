import { requireAdmin } from "@/lib/admin";
import { EMBED_MODEL, EMBED_DIM } from "@/lib/gemini";
import { getModelCatalog } from "@/lib/model-catalog";
import { getRawConfigRow, refreshConfig, openaiOAuthEnabled, envModelDefaults } from "@/lib/model-config";
import { readStoreStatus } from "@/lib/openai-oauth";
import { ModelsForm } from "./ModelsForm";
import { OAuthPanel } from "./OAuthPanel";
import { refreshCatalogAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminSettings() {
  await requireAdmin();
  await refreshConfig();
  const [catalog, row] = await Promise.all([getModelCatalog(), getRawConfigRow()]);
  const env = envModelDefaults();
  const oauthStatus = readStoreStatus();

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 space-y-10">
      <div>
        <h1 className="text-2xl font-bold">앱 설정</h1>
        <nav className="text-sm text-gray-500 mt-1">
          <a href="/admin/users" className="underline">유저 관리</a> · <span className="text-gray-800">앱 설정</span>
        </nav>
      </div>

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

      <OAuthPanel status={oauthStatus} enabled={openaiOAuthEnabled()} baseUrlSet={!!process.env.OPENAI_BASE_URL} />

      <form action={refreshCatalogAction}>
        <button className="text-xs underline text-gray-500">모델 목록 새로고침 (models.dev)</button>
      </form>
    </main>
  );
}
