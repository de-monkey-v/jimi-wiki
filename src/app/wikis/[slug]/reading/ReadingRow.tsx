"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { deleteSavedLinkAction, promoteSavedLinkAction } from "@/app/wikis/actions";

/** 읽을거리 한 행: 열기(새 탭) · 정식 편입(ingest) · 삭제. 외부 링크라 마크다운 대신 직접 target=_blank. */
export function ReadingRow({
  wikiSlug,
  id,
  url,
  title,
  description,
  savedAt,
  promoted,
  canPromote,
}: {
  wikiSlug: string;
  id: string;
  url: string;
  title: string;
  description: string | null;
  savedAt: string;
  promoted: boolean;
  canPromote: boolean;
}) {
  const t = useTranslations("WikisSlugReadingPage");
  const [pending, start] = useTransition();
  const router = useRouter();
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* 방어 — url은 http/https로 검증됨 */
  }

  return (
    <li className={`flex items-start gap-3 py-3 ${promoted ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <a href={url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-medium text-stone-800 hover:text-indigo-600 hover:underline">
            {title}
          </a>
          {promoted && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">✓ {t("promoted")}</span>}
        </div>
        {description && <p className="mt-0.5 line-clamp-2 text-sm text-stone-500">{description}</p>}
        <p className="mt-0.5 truncate text-xs text-stone-400">{host} · {savedAt}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <a href={url} target="_blank" rel="noopener noreferrer" className="rounded border px-2 py-1 text-xs text-stone-600 hover:bg-stone-50">
          {t("open")}
        </a>
        {canPromote && !promoted && (
          <button
            type="button"
            disabled={pending}
            title={t("promoteHint")}
            onClick={() =>
              start(async () => {
                const runId = await promoteSavedLinkAction(wikiSlug, id);
                router.push(`/wikis/${encodeURIComponent(wikiSlug)}?run=${runId}`);
              })
            }
            className="rounded border px-2 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
          >
            {t("promote")}
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await deleteSavedLinkAction(wikiSlug, id);
              router.refresh();
            })
          }
          className="rounded border px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {t("delete")}
        </button>
      </div>
    </li>
  );
}
