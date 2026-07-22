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
    <li
      className={`grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-4 ${
        promoted ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="line-clamp-2 min-w-0 flex-1 break-words text-[15px] font-semibold leading-5 text-stone-800 hover:text-indigo-600 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:line-clamp-1"
          >
            {title}
          </a>
          {promoted && <span className="mt-0.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">✓ {t("promoted")}</span>}
        </div>
        {description && <p className="mt-1.5 line-clamp-3 text-sm leading-5 text-stone-500 lg:line-clamp-2">{description}</p>}
        <p className="mt-2 truncate text-xs text-stone-400">{host} · {savedAt}</p>
      </div>
      <div className="flex w-full shrink-0 items-center gap-2 border-t border-stone-100 pt-3 lg:w-auto lg:gap-1 lg:border-t-0 lg:pt-0">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 flex-1 touch-manipulation items-center justify-center whitespace-nowrap rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 lg:min-h-0 lg:flex-none lg:rounded lg:px-2 lg:py-1 lg:text-xs lg:font-normal"
        >
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
            className="min-h-11 flex-1 touch-manipulation whitespace-nowrap rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2 text-sm font-medium text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 lg:flex-none lg:rounded lg:px-2 lg:py-1 lg:text-xs lg:font-normal"
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
          className="min-h-11 flex-1 touch-manipulation whitespace-nowrap rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:border-red-300 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 lg:flex-none lg:rounded lg:px-2 lg:py-1 lg:text-xs lg:font-normal"
        >
          {t("delete")}
        </button>
      </div>
    </li>
  );
}
