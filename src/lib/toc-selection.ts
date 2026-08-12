import type { TocEntry, TocLeaf, TocSection } from "@/lib/kinds";

export type TocSelectionPage = Pick<TocLeaf, "slug" | "title" | "currentVersion" | "trashable">;

/** 목차의 canonical 순서로 페이지를 평탄화한다. 고정 항목 같은 alias는 이 목록에 섞지 않는다. */
export function flattenTocPages(sections: readonly TocSection[]): TocSelectionPage[] {
  const pages: TocSelectionPage[] = [];
  const walk = (entries: readonly TocEntry[]) => {
    for (const entry of entries) {
      if (entry.type === "page") pages.push(entry);
      else walk(entry.children);
    }
  };
  for (const section of sections) walk(section.entries);
  return pages;
}

/** 접혀 있어도 폴더 명시 선택에는 모든 자손이 포함된다. 삭제 불가 leaf는 제외한다. */
export function selectableSlugsInEntries(entries: readonly TocEntry[]): string[] {
  const slugs: string[] = [];
  const walk = (nodes: readonly TocEntry[]) => {
    for (const node of nodes) {
      if (node.type === "page") {
        if (node.trashable) slugs.push(node.slug);
      } else {
        walk(node.children);
      }
    }
  };
  walk(entries);
  return slugs;
}

export function reconcileTocSelection(
  selected: ReadonlySet<string>,
  selectable: ReadonlySet<string>,
): Set<string> {
  return new Set([...selected].filter((slug) => selectable.has(slug)));
}

/** Shift 범위는 호출측이 넘긴 "현재 보이는 canonical leaf"만 추가한다. */
export function addVisibleRange(
  selected: ReadonlySet<string>,
  visibleSlugs: readonly string[],
  anchorSlug: string | null,
  targetSlug: string,
): Set<string> {
  const next = new Set(selected);
  const anchorIndex = anchorSlug ? visibleSlugs.indexOf(anchorSlug) : -1;
  const targetIndex = visibleSlugs.indexOf(targetSlug);
  if (anchorIndex < 0 || targetIndex < 0) {
    if (next.has(targetSlug)) next.delete(targetSlug);
    else next.add(targetSlug);
    return next;
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  for (const slug of visibleSlugs.slice(start, end + 1)) next.add(slug);
  return next;
}

export function setTocGroupSelected(
  selected: ReadonlySet<string>,
  slugs: readonly string[],
  value: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const slug of slugs) {
    if (value) next.add(slug);
    else next.delete(slug);
  }
  return next;
}

export function tocGroupSelectionState(
  selected: ReadonlySet<string>,
  slugs: readonly string[],
): { checked: boolean; mixed: boolean; selectedCount: number } {
  const selectedCount = slugs.reduce((count, slug) => count + (selected.has(slug) ? 1 : 0), 0);
  return {
    checked: slugs.length > 0 && selectedCount === slugs.length,
    mixed: selectedCount > 0 && selectedCount < slugs.length,
    selectedCount,
  };
}
