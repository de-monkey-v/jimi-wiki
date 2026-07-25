// 채팅 라우트 즉시 로딩 스켈레톤 — 무거운 클라 청크(ai SDK·마크다운) 로드 동안 즉각 피드백.
import { useTranslations } from "next-intl";

export default function ChatLoading() {
  const t = useTranslations("WikisSlugChatLoading");
  return (
    <main className="mx-auto workspace-measure px-6 py-10">
      <div className="mb-3 h-4 w-40 animate-pulse rounded bg-stone-100" />
      <div className="mb-2 h-7 w-32 animate-pulse rounded bg-stone-100" />
      <div className="mb-4 h-4 w-72 animate-pulse rounded bg-stone-100" />
      <div className="flex h-[68vh] items-center justify-center rounded-lg border border-stone-200 bg-white">
        <span className="text-sm text-stone-400">{t("callingJimi")}</span>
      </div>
    </main>
  );
}
