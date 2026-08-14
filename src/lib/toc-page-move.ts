import type { TocSection } from "@/lib/kinds";
import type { TocSelectionPage } from "@/lib/toc-selection";

export const TOC_PAGE_DRAG_THRESHOLD_PX = 6;
export const TOC_FOLDER_OPEN_DELAY_MS = 600;

export function hasCrossedTocPageDragThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= TOC_PAGE_DRAG_THRESHOLD_PX;
}

export type TocPageMovePayload = {
  pages: TocSelectionPage[];
  items: { slug: string; expectedVersion: number }[];
  replaceSelection: boolean;
};

/** threshold를 넘는 순간의 canonical selection으로 드래그 payload를 고정한다. */
export function tocPageMovePayloadForHandle(
  grabbed: TocSelectionPage,
  canonicalPages: readonly TocSelectionPage[],
  selected: ReadonlySet<string>,
  selectionMode: boolean,
): TocPageMovePayload | null {
  if (!grabbed.movable) return null;
  const useSelection = selectionMode && selected.has(grabbed.slug);
  const pages = useSelection
    ? canonicalPages.filter((page) => selected.has(page.slug))
    : [grabbed];
  if (pages.length === 0 || pages.some((page) => !page.movable)) return null;
  return {
    pages,
    items: pages.map((page) => ({ slug: page.slug, expectedVersion: page.currentVersion })),
    replaceSelection: selectionMode && !useSelection,
  };
}

export type TocDropTargetState = "valid" | "current" | "invalid";

export function tocDropTargetState(
  pages: readonly Pick<TocSelectionPage, "category" | "movable">[],
  category: string | null,
): TocDropTargetState {
  if (pages.length === 0 || pages.some((page) => !page.movable)) return "invalid";
  return pages.every((page) => page.category === category) ? "current" : "valid";
}

/** 모든 보이는 canonical 폴더와 사용자 고정 폴더를 category key 기준으로 합친다. */
export function collectTocCategoryTargets(
  sections: readonly TocSection[],
  pinnedCategories: readonly string[],
): (string | null)[] {
  const categories = new Set<string>();
  const walk = (entries: TocSection["entries"]) => {
    for (const entry of entries) {
      if (entry.type === "folder") {
        categories.add(entry.path);
        walk(entry.children);
      }
    }
  };
  for (const section of sections) walk(section.entries);
  for (const category of pinnedCategories) if (category) categories.add(category);
  return [null, ...categories];
}

export function tocEdgeAutoScrollDelta(clientY: number, top: number, bottom: number, edge = 44): number {
  if (clientY < top || clientY > bottom || bottom <= top) return 0;
  const topDistance = clientY - top;
  const bottomDistance = bottom - clientY;
  if (topDistance < edge) return -Math.ceil((edge - topDistance) / 4);
  if (bottomDistance < edge) return Math.ceil((edge - bottomDistance) / 4);
  return 0;
}
