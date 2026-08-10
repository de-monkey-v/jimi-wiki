import type { TocEntry, TocSection } from "@/lib/kinds";

export const FOLDER_SORT_MODES = ["newest", "oldest", "title"] as const;
export type FolderSortMode = (typeof FOLDER_SORT_MODES)[number];

export const FOLDER_SORT_SELECTIONS = ["auto", ...FOLDER_SORT_MODES] as const;
export type FolderSortSelection = (typeof FOLDER_SORT_SELECTIONS)[number];

export type FolderSortablePage = {
  slug: string;
  title: string;
  kind: string;
  category: string | null;
  documentAt: Date | null;
  createdAt: Date;
};

export function isFolderSortSelection(value: unknown): value is FolderSortSelection {
  return typeof value === "string" && FOLDER_SORT_SELECTIONS.includes(value as FolderSortSelection);
}

/** DB collation이나 실행 호스트 locale에 기대지 않는 NFC/code-point 순서. */
export function compareFolderText(a: string, b: string): number {
  const normalizedA = a.normalize("NFC");
  const normalizedB = b.normalize("NFC");
  if (normalizedA < normalizedB) return -1;
  if (normalizedA > normalizedB) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 빈 세그먼트를 제거해 TOC가 사용하는 category 경로 표기와 맞춘다. */
export function normalizeFolderCategory(category: string | null | undefined): string {
  return (category ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

export function categoryIsInSubtree(category: string | null | undefined, root: string): boolean {
  const normalizedCategory = normalizeFolderCategory(category);
  const normalizedRoot = normalizeFolderCategory(root);
  if (!normalizedRoot) return true;
  return normalizedCategory === normalizedRoot || normalizedCategory.startsWith(`${normalizedRoot}/`);
}

export function resolveFolderSortMode(
  stored: FolderSortMode | null | undefined,
  pages: readonly FolderSortablePage[],
  category = "",
): FolderSortMode {
  if (stored) return stored;
  return pages.some((page) => page.kind === "document" && categoryIsInSubtree(page.category, category))
    ? "newest"
    : "title";
}

function compareTitleThenSlug(a: FolderSortablePage, b: FolderSortablePage): number {
  return compareFolderText(a.title, b.title) || compareFolderText(a.slug, b.slug);
}

function sortTimestamp(page: FolderSortablePage): number {
  return (page.documentAt ?? page.createdAt).getTime();
}

export function compareFolderPages(
  a: FolderSortablePage,
  b: FolderSortablePage,
  mode: FolderSortMode,
): number {
  if (mode !== "title") {
    const byTime = sortTimestamp(a) - sortTimestamp(b);
    if (byTime !== 0) return mode === "newest" ? -byTime : byTime;
  }
  return compareTitleThenSlug(a, b);
}

type FolderBucket<T extends FolderSortablePage> = {
  path: string;
  directPages: T[];
  children: Map<string, FolderBucket<T>>;
};

/**
 * 한 폴더 subtree의 canonical leaf 순서.
 * 각 노드에서 하위 폴더(이름순)를 먼저 순회하고, 그 뒤 직접 페이지에 해당 폴더 mode를 적용한다.
 */
export function sortFolderSubtreePages<T extends FolderSortablePage>(
  pages: readonly T[],
  rootCategory: string,
  preferences: ReadonlyMap<string, FolderSortMode> = new Map(),
  autoContextPages: readonly FolderSortablePage[] = pages,
): T[] {
  const rootPath = normalizeFolderCategory(rootCategory);
  const root: FolderBucket<T> = { path: rootPath, directPages: [], children: new Map() };

  for (const page of pages) {
    const pageCategory = normalizeFolderCategory(page.category);
    if (!categoryIsInSubtree(pageCategory, rootPath)) continue;
    const relative = rootPath
      ? pageCategory === rootPath
        ? ""
        : pageCategory.slice(rootPath.length + 1)
      : pageCategory;
    const segments = relative ? relative.split("/") : [];
    let bucket = root;
    for (const segment of segments) {
      const childPath = bucket.path ? `${bucket.path}/${segment}` : segment;
      let child = bucket.children.get(segment);
      if (!child) {
        child = { path: childPath, directPages: [], children: new Map() };
        bucket.children.set(segment, child);
      }
      bucket = child;
    }
    bucket.directPages.push(page);
  }

  const flatten = (bucket: FolderBucket<T>): T[] => {
    const childPages = [...bucket.children.entries()]
      .sort(([nameA, a], [nameB, b]) => compareFolderText(nameA, nameB) || compareFolderText(a.path, b.path))
      .flatMap(([, child]) => flatten(child));
    const mode = bucket.path
      ? resolveFolderSortMode(preferences.get(bucket.path), autoContextPages, bucket.path)
      : "title";
    const directPages = [...bucket.directPages].sort((a, b) => compareFolderPages(a, b, mode));
    return [...childPages, ...directPages];
  };

  return flatten(root);
}

function findFolder(entries: readonly TocEntry[], category: string): Extract<TocEntry, { type: "folder" }> | null {
  for (const entry of entries) {
    if (entry.type === "page") continue;
    if (entry.path === category) return entry;
    const nested = findFolder(entry.children, category);
    if (nested) return nested;
  }
  return null;
}

function flattenTocLeaves(entries: readonly TocEntry[]): string[] {
  return entries.flatMap((entry) => entry.type === "page" ? [entry.slug] : flattenTocLeaves(entry.children));
}

const CATEGORY_SECTION_ORDER: TocSection["key"][] = ["documents", "knowledge", "personal", "sources"];

/** category 페이지가 사이드바와 같은 section/tree leaf 순서를 사용할 때 쓰는 slug 목록. */
export function categoryTocSlugOrder(sections: readonly TocSection[], category: string): string[] {
  const normalized = normalizeFolderCategory(category);
  const byKey = new Map(sections.map((section) => [section.key, section]));
  return CATEGORY_SECTION_ORDER.flatMap((key) => {
    const section = byKey.get(key);
    if (!section) return [];
    const folder = findFolder(section.entries, normalized);
    return folder ? flattenTocLeaves(folder.children) : [];
  });
}
