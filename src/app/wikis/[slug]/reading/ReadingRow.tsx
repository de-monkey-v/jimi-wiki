"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { deleteSavedLinkAction, promoteSavedLinkAction } from "@/app/wikis/actions";
import { Tooltip } from "@/components/ui/Tooltip";

/** 읽을거리 한 행: 열기(새 탭) · 정식 편입(ingest) · 삭제. 외부 링크라 마크다운 대신 직접 target=_blank. */
export function ReadingRow({
  wikiSlug,
  id,
  url,
  title,
  description,
  summary,
  savedAt,
  promoted,
  canPromote,
  navProps,
}: {
  wikiSlug: string;
  id: string;
  url: string;
  title: string;
  description: string | null;
  summary: string | null;
  savedAt: string;
  promoted: boolean;
  canPromote: boolean;
  navProps?: React.LiHTMLAttributes<HTMLLIElement>; // useListNav 컨테이너가 주입(키보드 탐색 활성 표시)
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
      {...navProps}
      className={`group/row -mx-3 grid gap-3 rounded-lg px-3 py-4 transition-colors hover:bg-stone-50 data-active:bg-stone-50 motion-reduce:transition-none lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-4 ${
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
        {summary && (
          <details className="mt-2 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700">
            <summary className="cursor-pointer font-medium">{t("summary")}</summary>
            <p className="mt-2 break-words whitespace-pre-wrap leading-6">{summary}</p>
          </details>
        )}
        <p className="mt-2 truncate text-xs text-stone-400">{host} · {savedAt}</p>
      </div>
      {/* 데스크톱(lg+)은 hover/focus 시에만 액션 노출(opacity 전환 — display 숨김이 아니라 키보드 포커스 도달 가능). 모바일은 항상 표시. */}
      <div className="flex w-full shrink-0 items-center gap-2 border-t border-stone-100 pt-3 transition-opacity motion-reduce:transition-none lg:w-auto lg:gap-1 lg:border-t-0 lg:pt-0 lg:opacity-0 lg:group-focus-within/row:opacity-100 lg:group-hover/row:opacity-100">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 flex-1 touch-manipulation items-center justify-center whitespace-nowrap rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 lg:min-h-0 lg:flex-none lg:rounded lg:px-2 lg:py-1 lg:text-xs lg:font-normal"
        >
          {t("open")}
        </a>
        {canPromote && !promoted && (
          <Tooltip label={t("promoteHint")}>
          <button
            type="button"
            disabled={pending}
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
          </Tooltip>
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
          className="min-h-11 flex-1 touch-manipulation whitespace-nowrap rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-600 hover:border-rose-300 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 lg:flex-none lg:rounded lg:px-2 lg:py-1 lg:text-xs lg:font-normal"
        >
          {t("delete")}
        </button>
      </div>
    </li>
  );
}
