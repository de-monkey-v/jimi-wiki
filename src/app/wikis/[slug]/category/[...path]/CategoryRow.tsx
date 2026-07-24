"use client";
import { useQuickNav } from "@/app/wikis/[slug]/QuickNav";
import { PreviewLink } from "@/components/ui/PreviewLink";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * 카테고리 목록 한 행. 개인 노트(movable)는 데스크톱에서 hover 시 폴더 이동(⋯) 액션이 드러난다 —
 * opacity로만 숨겨 키보드 포커스(focus-within)로도 도달 가능하고, 모바일(md 미만)은 항상 표시.
 */
export type CategoryRowProps = {
  wikiSlug: string;
  pageSlug: string;
  title: string;
  categoryLabel: string | null;
  kindLabel: string;
  movable: boolean;
  currentCategory: string | null;
  currentVersion: number;
  moveLabel: string;
  navProps?: React.LiHTMLAttributes<HTMLLIElement>; // useListNav 컨테이너가 주입(키보드 탐색 활성 표시)
};

export function CategoryRow({
  wikiSlug,
  pageSlug,
  title,
  categoryLabel,
  kindLabel,
  movable,
  currentCategory,
  currentVersion,
  moveLabel,
  navProps,
}: CategoryRowProps) {
  const quick = useQuickNav();
  return (
    <li {...navProps} className="group/row row-hover -mx-2 flex flex-wrap items-center gap-2 px-2 py-1 data-active:bg-stone-100">
      <PreviewLink
        pageSlug={pageSlug}
        href={`/wikis/${wikiSlug}/${encodeURIComponent(pageSlug)}`}
        className="text-blue-600 hover:underline"
      >
        {title}
      </PreviewLink>
      {categoryLabel && <span className="text-xs text-stone-400">{categoryLabel}</span>}
      <span className="text-xs text-stone-300">{kindLabel}</span>
      {movable && quick && (
        <Tooltip label={moveLabel}>
          <button
            type="button"
            aria-label={moveLabel}
            onClick={() => quick.openMove(pageSlug, currentCategory, currentVersion)}
            className="ml-auto rounded px-1.5 text-sm text-stone-400 transition-opacity hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 motion-reduce:transition-none md:opacity-0 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100"
          >
            ⋯
          </button>
        </Tooltip>
      )}
    </li>
  );
}
