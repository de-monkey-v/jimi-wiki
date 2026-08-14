"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { logoutAction } from "@/app/login/actions";
import {
  movePagesToCategoryAction,
  restorePageCategoriesAction,
} from "@/app/wikis/actions";
import { useChatModal, useShortcutLabel } from "@/app/wikis/[slug]/chat/ChatModal";
import { trashPagesFromTocAction } from "@/app/wikis/[slug]/knowledge-controls-actions";
import { useWikiActions } from "@/app/wikis/[slug]/WikiActions";
import { useQuickNav } from "@/app/wikis/[slug]/QuickNav";
import { RecentPopover } from "@/app/wikis/[slug]/RecentList";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "@/components/Modal";
import { PageKebabMenu } from "@/components/PageKebabMenu";
import { Tooltip } from "@/components/ui/Tooltip";
import type { TocSection, TocEntry } from "@/lib/kinds";
import {
  addVisibleRange,
  flattenTocPages,
  reconcileTocSelection,
  selectableSlugsInEntries,
  setTocGroupSelected,
  tocGroupSelectionState,
} from "@/lib/toc-selection";
import {
  DEFAULT_WIKI_TOC_WIDTH,
  MAX_WIKI_TOC_WIDTH,
  MIN_WIKI_TOC_WIDTH,
  WIKI_TOC_WIDTH_STORAGE_KEY,
  displayedWikiTocWidth,
  normalizeWikiTocWidth,
  parseStoredWikiTocWidth,
  wikiTocViewportMax,
} from "@/lib/wiki-toc-width";
import { isReservedWikiPageSlug } from "@/lib/wiki-routes";
import {
  TOC_FOLDER_OPEN_DELAY_MS,
  collectTocCategoryTargets,
  hasCrossedTocPageDragThreshold,
  tocDropTargetState,
  tocEdgeAutoScrollDelta,
  tocPageMovePayloadForHandle,
  type TocDropTargetState,
  type TocPageMovePayload,
} from "@/lib/toc-page-move";
import type { TocSelectionPage } from "@/lib/toc-selection";
import type { PageCategoryMoveReceipt } from "@/lib/page-category-move";

type PinnedItem =
  | { type: "page"; slug: string; title: string }
  | { type: "folder"; category: string };

type TocResizeDrag = {
  pointerId: number;
  startX: number;
  startWidth: number;
};

type TocSelectionDrag = {
  pointerId: number;
  value: boolean;
  visited: Set<string>;
  clientX: number;
  clientY: number;
  frame: number | null;
};

type TocSelectionView = {
  selected: ReadonlySet<string>;
  pending: boolean;
  pageLabel: (title: string) => string;
  unavailableLabel: (title: string) => string;
  groupLabel: (name: string, count: number) => string;
};

type TocPageMoveGesture = {
  pointerId: number;
  handle: HTMLButtonElement;
  grabbed: TocSelectionPage;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  started: boolean;
  payload: TocPageMovePayload | null;
  targetCategory: string | null | undefined;
  targetState: TocDropTargetState;
  frame: number | null;
  autoScrollDirection: -1 | 0 | 1;
  autoScrollStartedAt: number | null;
};

type TocPageMoveView = {
  pages: TocSelectionPage[];
  clientX: number;
  clientY: number;
  targetCategory: string | null | undefined;
  targetState: TocDropTargetState;
};

type TocPageMoveController = {
  pending: boolean;
  dragging: boolean;
  targetCategory: string | null | undefined;
  targetState: (category: string | null) => TocDropTargetState;
  openSingle: (page: TocSelectionPage) => void;
  handleLabel: (title: string) => string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, page: TocSelectionPage) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  suppressClick: (event: ReactMouseEvent<HTMLButtonElement>) => boolean;
};

// 폴더를 가리킨 첫 animation frame에 그 폴더를 밀어내지 않도록 짧게 대기한다.
// edge를 계속 잡고 있으면 스크롤하되, 빠른 drop은 사용자가 본 highlight를 확정한다.
const TOC_PAGE_MOVE_AUTO_SCROLL_DELAY_MS = 180;

function linkCls(active: boolean, mobileTwoLines = false) {
  const overflow = mobileTwoLines ? "line-clamp-2 md:block md:truncate" : "truncate";
  return `block ${overflow} rounded-md py-1 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
    active ? "bg-stone-200 text-stone-900 font-medium" : "text-stone-600 hover:bg-stone-100"
  }`;
}

function entryHasSlug(e: TocEntry, slug: string | undefined): boolean {
  if (!slug) return false;
  if (e.type === "page") return e.slug === slug;
  return e.children.some((c) => entryHasSlug(c, slug));
}
function leafCount(e: TocEntry): number {
  return e.type === "page" ? 1 : e.children.reduce((n, c) => n + leafCount(c), 0);
}

// 페이지 리프와 폴더를 컴포넌트로 분리 — 훅이 early return 뒤에 오면(rules-of-hooks 위반)
// hydration이 통째로 죽어 사이드바 전체가 클릭 불능이 된다.
// newKind: 이 섹션에서 "+ 새 노트" 버튼이 만들 kind(personal|concept). undefined면 "+" 없음(원문/소스).
// canMove/canTrash는 역할 조건이고 실제 eligibility는 server-derived leaf 필드와 AND한다.
type NodeCtx = {
  slug: string;
  current: string | undefined;
  newKind?: string;
  canMove: boolean;
  canTrash: boolean;
  newInFolderLabel: (name: string) => string;
  selection?: TocSelectionView;
  move?: TocPageMoveController;
};

type EntryNodeProps = {
  entry: TocEntry;
  ctx: NodeCtx;
  depth: number;
  parentPath: string;
  onTogglePage?: (slug: string, shiftKey: boolean, allowRange: boolean) => void;
  onToggleGroup?: (slugs: readonly string[], value: boolean) => void;
  onCheckboxPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>, slug: string) => void;
  onCheckboxPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onCheckboxPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onCheckboxPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onCheckboxLostPointerCapture?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onCheckboxClick?: (event: ReactMouseEvent<HTMLButtonElement>, slug: string) => void;
};

function SelectionCheckbox({
  checked,
  mixed = false,
  label,
  disabled = false,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  draggable = false,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  draggable?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-bold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 ${
        checked || mixed
          ? "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700"
          : "border-stone-300 bg-white text-transparent hover:border-indigo-400 hover:bg-indigo-50"
      } ${draggable ? "cursor-cell touch-pan-y select-none" : ""}`}
    >
      <span aria-hidden="true">{mixed ? "−" : checked ? "✓" : "·"}</span>
    </button>
  );
}

function PageMoveHandle({ page, move }: { page: TocSelectionPage; move: TocPageMoveController }) {
  return (
    <button
      type="button"
      aria-label={move.handleLabel(page.title)}
      aria-haspopup="dialog"
      disabled={move.pending}
      onClick={(event) => {
        if (!move.suppressClick(event)) move.openSingle(page);
      }}
      onPointerDown={(event) => move.onPointerDown(event, page)}
      onPointerMove={move.onPointerMove}
      onPointerUp={move.onPointerUp}
      onPointerCancel={move.onPointerCancel}
      onLostPointerCapture={move.onLostPointerCapture}
      className="toc-page-drag-handle absolute right-8 top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 touch-none select-none items-center justify-center rounded-md border border-transparent bg-white/90 text-sm font-bold tracking-[-0.15em] text-stone-400 opacity-0 shadow-sm transition-[opacity,color,border-color,background-color] motion-reduce:transition-none hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 active:border-indigo-300 active:bg-indigo-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-30 md:flex md:group-hover/leaf:opacity-100 md:group-focus-within/leaf:opacity-100 [@media(pointer:coarse)]:!hidden"
    >
      <span aria-hidden="true">⠿</span>
    </button>
  );
}

// root의 pinned map에서 ref-backed gesture controller를 직접 펼치지 않게 컴포넌트 경계를 둔다.
function PinnedPageMoveHandle({ page, move }: { page: TocSelectionPage; move: TocPageMoveController }) {
  return <PageMoveHandle page={page} move={move} />;
}

function PinnedTocEntry({
  item,
  slug,
  current,
  selectionMode,
  selected,
  canonical,
  pending,
  canWrite,
  move,
  moveView,
  selectLabel,
  onToggle,
}: {
  item: PinnedItem;
  slug: string;
  current: string | undefined;
  selectionMode: boolean;
  selected: boolean;
  canonical: TocSelectionPage | undefined;
  pending: boolean;
  canWrite: boolean;
  move: TocPageMoveController | undefined;
  moveView: TocPageMoveView | null;
  selectLabel: string;
  onToggle: (shiftKey: boolean) => void;
}) {
  if (item.type === "folder") {
    const folderName = item.category.split("/").pop() ?? item.category;
    const folderDropState = moveView ? tocDropTargetState(moveView.pages, item.category) : "invalid";
    const folderTargeted = moveView !== null && moveView.targetCategory === item.category;
    const folderDropClass = folderTargeted && folderDropState === "valid"
      ? "border-indigo-300 bg-indigo-100 text-indigo-900 ring-2 ring-indigo-400 ring-offset-1"
      : folderTargeted
        ? "border-stone-200 bg-stone-100 text-stone-400"
        : "border-transparent";
    return (
      <li>
        <Tooltip label={folderName}>
          {selectionMode ? (
            <div
              data-toc-drop-category={canWrite ? item.category : undefined}
              className={`flex min-h-8 items-center gap-1 rounded-md border px-2 text-sm transition-[background-color,border-color,color,box-shadow] motion-reduce:transition-none ${folderDropClass}`}
              aria-disabled={folderTargeted && folderDropState !== "valid" ? true : undefined}
            >
              <span className="shrink-0" aria-hidden="true">📁</span>
              <span className="min-w-0 flex-1 truncate">{folderName}</span>
            </div>
          ) : (
            <Link
              href={`/wikis/${slug}/category/${item.category.split("/").map(encodeURIComponent).join("/")}`}
              data-toc-drop-category={canWrite ? item.category : undefined}
              aria-disabled={folderTargeted && folderDropState !== "valid" ? true : undefined}
              className={`flex items-center gap-1 border transition-[background-color,border-color,color,box-shadow] motion-reduce:transition-none ${folderDropClass} ${linkCls(false)}`}
              style={{ paddingLeft: 20 }}
            >
              <span className="shrink-0 text-stone-400" aria-hidden="true">📁</span>
              <span className="min-w-0 flex-1 truncate">{folderName}</span>
            </Link>
          )}
        </Tooltip>
      </li>
    );
  }

  return (
    <li className={selectionMode && selected ? "rounded-md bg-indigo-50" : undefined}>
      <Tooltip label={item.title}>
        {selectionMode && canonical && (canonical.trashable || canonical.movable) ? (
          <div className="group/leaf relative flex min-h-8 items-center gap-1.5 rounded-md px-1">
            <SelectionCheckbox
              checked={selected}
              label={selectLabel}
              disabled={pending}
              onClick={(event) => onToggle(event.shiftKey)}
            />
            <button
              type="button"
              disabled={pending}
              onClick={(event) => onToggle(event.shiftKey)}
              className="min-w-0 flex-1 rounded px-1 py-1 text-left text-sm text-stone-700 hover:bg-indigo-100 active:bg-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed"
            >
              <span className="mr-1 text-amber-500" aria-hidden="true">★</span>
              <span className="line-clamp-2 md:inline md:truncate">{item.title}</span>
            </button>
            {canWrite && canonical.movable && move ? <PinnedPageMoveHandle page={canonical} move={move} /> : null}
          </div>
        ) : selectionMode ? (
          <div className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sm text-stone-400" aria-disabled="true">
            <span className="shrink-0 text-amber-400" aria-hidden="true">★</span>
            <span className="min-w-0 flex-1 line-clamp-2 md:block md:truncate">{item.title}</span>
          </div>
        ) : (
          <div className="group/leaf relative">
            <Link href={`/wikis/${slug}/${item.slug}`} className={`flex items-center gap-1 !pr-10 ${linkCls(item.slug === current)}`} style={{ paddingLeft: 20 }}>
              <span className="shrink-0 text-amber-500" aria-hidden="true">★</span>
              <span className="min-w-0 flex-1 whitespace-normal line-clamp-2 md:block md:truncate">{item.title}</span>
            </Link>
            {canWrite && canonical?.movable && move ? <PinnedPageMoveHandle page={canonical} move={move} /> : null}
          </div>
        )}
      </Tooltip>
    </li>
  );
}

function EntryNode({
  entry,
  ctx,
  depth,
  onTogglePage,
  onToggleGroup,
  onCheckboxPointerDown,
  onCheckboxPointerMove,
  onCheckboxPointerUp,
  onCheckboxPointerCancel,
  onCheckboxLostPointerCapture,
  onCheckboxClick,
}: EntryNodeProps) {
  if (entry.type === "page") {
    if (ctx.selection) {
      const selected = ctx.selection.selected.has(entry.slug);
      const selectable = entry.trashable || entry.movable;
      return (
        <li
          data-toc-select-slug={selectable ? entry.slug : undefined}
          className={`group/leaf relative rounded-md border-l-2 transition-colors motion-reduce:transition-none ${
            selected ? "border-indigo-500 bg-indigo-50 text-indigo-950" : "border-transparent hover:bg-stone-50"
          }`}
        >
          <div className="flex min-h-9 items-center gap-1.5 pr-1" style={{ paddingLeft: depth * 12 + 4 }}>
            <SelectionCheckbox
              checked={selected}
              label={selectable ? ctx.selection.pageLabel(entry.title) : ctx.selection.unavailableLabel(entry.title)}
              disabled={!selectable || ctx.selection.pending}
              draggable={selectable}
              onClick={(event) => onCheckboxClick?.(event, entry.slug)}
              onPointerDown={selectable ? (event) => onCheckboxPointerDown?.(event, entry.slug) : undefined}
              onPointerMove={selectable ? onCheckboxPointerMove : undefined}
              onPointerUp={selectable ? onCheckboxPointerUp : undefined}
              onPointerCancel={selectable ? onCheckboxPointerCancel : undefined}
              onLostPointerCapture={selectable ? onCheckboxLostPointerCapture : undefined}
            />
            <button
              type="button"
              disabled={!selectable || ctx.selection.pending}
              onClick={(event) => onTogglePage?.(entry.slug, event.shiftKey, true)}
              className={`min-w-0 flex-1 rounded py-1 pl-1 pr-9 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:bg-indigo-100 disabled:cursor-not-allowed ${
                selectable ? "text-stone-700 hover:text-stone-950" : "text-stone-400"
              }`}
            >
              <span className="line-clamp-2 md:block md:truncate">{entry.title}</span>
            </button>
            {ctx.canMove && entry.movable && ctx.move ? <PageMoveHandle page={entry} move={ctx.move} /> : null}
          </div>
        </li>
      );
    }
    return (
      <li className="group/leaf relative">
        <Tooltip label={entry.title}>
          <Link href={`/wikis/${ctx.slug}/${entry.slug}`} className={`${linkCls(entry.slug === ctx.current, true)} !pr-16`} style={{ paddingLeft: depth * 12 + 20 }}>
            {entry.title}
          </Link>
        </Tooltip>
        {ctx.canMove && entry.movable && ctx.move ? <PageMoveHandle page={entry} move={ctx.move} /> : null}
        <PageKebabMenu
          wikiSlug={ctx.slug}
          pageSlug={entry.slug}
          currentVersion={entry.currentVersion}
          currentCategory={entry.category}
          canMove={ctx.canMove && entry.movable && !ctx.move?.pending}
          canTrash={ctx.canTrash && entry.trashable}
          afterTrash={entry.slug === ctx.current ? "goHome" : "refresh"}
          triggerClassName="absolute right-0.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-sm text-stone-400"
        />
      </li>
    );
  }
  return (
    <FolderNode
      entry={entry}
      ctx={ctx}
      depth={depth}
      onTogglePage={onTogglePage}
      onToggleGroup={onToggleGroup}
      onCheckboxPointerDown={onCheckboxPointerDown}
      onCheckboxPointerMove={onCheckboxPointerMove}
      onCheckboxPointerUp={onCheckboxPointerUp}
      onCheckboxPointerCancel={onCheckboxPointerCancel}
      onCheckboxLostPointerCapture={onCheckboxLostPointerCapture}
      onCheckboxClick={onCheckboxClick}
    />
  );
}

function FolderNode({
  entry,
  ctx,
  depth,
  onTogglePage,
  onToggleGroup,
  onCheckboxPointerDown,
  onCheckboxPointerMove,
  onCheckboxPointerUp,
  onCheckboxPointerCancel,
  onCheckboxLostPointerCapture,
  onCheckboxClick,
}: Omit<EntryNodeProps, "entry" | "parentPath"> & { entry: Extract<TocEntry, { type: "folder" }> }) {
  const actions = useWikiActions();
  const active = entryHasSlug(entry, ctx.current);
  const [override, setOverride] = useState<{ open: boolean; whenActive: boolean } | null>(null);
  const open = override && override.whenActive === active ? override.open : active || depth < 1;
  const selectableSlugs = selectableSlugsInEntries(entry.children, "either");
  const selectionState = ctx.selection ? tocGroupSelectionState(ctx.selection.selected, selectableSlugs) : null;
  const dropState = ctx.move?.targetState(entry.path) ?? "invalid";
  const targeted = ctx.move?.dragging && ctx.move.targetCategory === entry.path;

  useEffect(() => {
    if (!targeted || dropState !== "valid" || open) return;
    const timer = window.setTimeout(() => {
      setOverride({ open: true, whenActive: active });
    }, TOC_FOLDER_OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, dropState, open, targeted]);

  return (
    <li>
      <div className="group/folder flex items-center">
        {ctx.selection && selectionState ? (
          <div style={{ marginLeft: depth * 12 + 4 }} className="mr-1">
            <SelectionCheckbox
              checked={selectionState.checked}
              mixed={selectionState.mixed}
              label={ctx.selection.groupLabel(entry.name, selectableSlugs.length)}
              disabled={selectableSlugs.length === 0 || ctx.selection.pending}
              onClick={() => onToggleGroup?.(selectableSlugs, !selectionState.checked)}
            />
          </div>
        ) : null}
        <Tooltip label={entry.name}>
          <button
            type="button"
            aria-expanded={open}
            data-toc-drop-category={ctx.move ? entry.path : undefined}
            aria-disabled={targeted && dropState !== "valid" ? true : undefined}
            onClick={() => setOverride({ open: !open, whenActive: active })}
            className={`flex min-w-0 flex-1 items-center gap-1 rounded-md border py-1 pr-2 text-sm transition-[background-color,border-color,color,box-shadow] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              targeted && dropState === "valid"
                ? "border-indigo-300 bg-indigo-100 text-indigo-900 ring-2 ring-indigo-400 ring-offset-1"
                : targeted
                  ? "border-stone-200 bg-stone-100 text-stone-400"
                  : "border-transparent text-stone-500 hover:bg-stone-100"
            }`}
            style={{ paddingLeft: ctx.selection ? 4 : depth * 12 + 4 }}
          >
            <span className="w-3 shrink-0 text-xs text-stone-400">{open ? "▾" : "▸"}</span>
            <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
            <span className="text-xs text-stone-300">{leafCount(entry)}</span>
          </button>
        </Tooltip>
        {!ctx.selection && ctx.newKind && actions && (
          <Tooltip label={ctx.newInFolderLabel(entry.name)}>
            <button
              type="button"
              aria-label={ctx.newInFolderLabel(entry.name)}
              onClick={() => actions.openNewPage({ category: entry.path, kind: ctx.newKind })}
              className="block shrink-0 rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              +
            </button>
          </Tooltip>
        )}
      </div>
      {open && (
        <ul className="mt-0.5 space-y-0.5">
          {entry.children.map((c) => (
            <EntryNode
              key={c.type === "folder" ? `f:${c.path}` : `p:${c.slug}`}
              entry={c}
              ctx={ctx}
              depth={depth + 1}
              parentPath={entry.path}
              onTogglePage={onTogglePage}
              onToggleGroup={onToggleGroup}
              onCheckboxPointerDown={onCheckboxPointerDown}
              onCheckboxPointerMove={onCheckboxPointerMove}
              onCheckboxPointerUp={onCheckboxPointerUp}
              onCheckboxPointerCancel={onCheckboxPointerCancel}
              onCheckboxLostPointerCapture={onCheckboxLostPointerCapture}
              onCheckboxClick={onCheckboxClick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// 섹션별 "+" 새 페이지 kind. sources는 전용 보관함이라 사용자 목차에는 나오지 않는다.
const SECTION_NEW_KIND: Record<TocSection["key"], string | undefined> = {
  personal: "personal",
  documents: "document",
  knowledge: "concept",
  sources: undefined,
};

function SecondarySection({
  section,
  ctx,
  label,
  onTogglePage,
  onToggleGroup,
  onCheckboxPointerDown,
  onCheckboxPointerMove,
  onCheckboxPointerUp,
  onCheckboxPointerCancel,
  onCheckboxLostPointerCapture,
  onCheckboxClick,
}: {
  section: TocSection;
  ctx: NodeCtx;
  label: string;
} & Pick<
  EntryNodeProps,
  | "onTogglePage"
  | "onToggleGroup"
  | "onCheckboxPointerDown"
  | "onCheckboxPointerMove"
  | "onCheckboxPointerUp"
  | "onCheckboxPointerCancel"
  | "onCheckboxLostPointerCapture"
  | "onCheckboxClick"
>) {
  const [open, setOpen] = useState(false);
  const count = section.entries.reduce((total, entry) => total + leafCount(entry), 0);
  const selectableSlugs = selectableSlugsInEntries(section.entries, "either");
  const selectionState = ctx.selection ? tocGroupSelectionState(ctx.selection.selected, selectableSlugs) : null;
  return (
    <div className="group/secondary">
      <div className="flex items-center gap-1">
        {ctx.selection && selectionState ? (
          <SelectionCheckbox
            checked={selectionState.checked}
            mixed={selectionState.mixed}
            label={ctx.selection.groupLabel(label, selectableSlugs.length)}
            disabled={selectableSlugs.length === 0 || ctx.selection.pending}
            onClick={() => onToggleGroup?.(selectableSlugs, !selectionState.checked)}
          />
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center rounded-md px-1 py-1 text-xs font-semibold uppercase tracking-wide text-stone-400 hover:bg-stone-50 active:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span
            className={`mr-1 text-[10px] transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          >
            ▸
          </span>
          <span className="min-w-0 flex-1 text-left">{label}</span>
          <span className="font-mono text-[10px] font-normal">{count}</span>
        </button>
      </div>
      {open ? (
        <ul className="mt-1 space-y-0.5">
          {section.entries.map((entry) => (
            <EntryNode
              key={entry.type === "folder" ? `f:${entry.path}` : `p:${entry.slug}`}
              entry={entry}
              ctx={ctx}
              depth={0}
              parentPath=""
              onTogglePage={onTogglePage}
              onToggleGroup={onToggleGroup}
              onCheckboxPointerDown={onCheckboxPointerDown}
              onCheckboxPointerMove={onCheckboxPointerMove}
              onCheckboxPointerUp={onCheckboxPointerUp}
              onCheckboxPointerCancel={onCheckboxPointerCancel}
              onCheckboxLostPointerCapture={onCheckboxLostPointerCapture}
              onCheckboxClick={onCheckboxClick}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WikiToc({
  slug,
  title,
  email,
  role,
  sections,
  pinned,
  showLogout,
}: {
  slug: string;
  title: string;
  email: string;
  role: "viewer" | "editor" | "owner";
  sections: TocSection[];
  pinned: PinnedItem[];
  showLogout: boolean;
}) {
  const t = useTranslations("WikiToc");
  const pathname = decodeURIComponent(usePathname());
  const seg = pathname.split("/"); // ["", "wikis", "<slug>", "<sub>", ...]
  const sub = seg[3];
  const inTrash = sub === "settings" && seg[4] === "trash";
  const current = sub && !isReservedWikiPageSlug(sub) ? sub : undefined;
  const router = useRouter();
  const chatModal = useChatModal();
  const actions = useWikiActions();
  const quick = useQuickNav();
  const shortcut = useShortcutLabel();
  const isMac = shortcut.startsWith("⌘");
  const canWrite = role !== "viewer";
  const canonicalPages = useMemo(() => flattenTocPages(sections), [sections]);
  const pageBySlug = useMemo(() => new Map(canonicalPages.map((page) => [page.slug, page])), [canonicalPages]);
  const selectablePages = useMemo(
    () => canonicalPages.filter((page) => page.trashable || page.movable),
    [canonicalPages],
  );
  const selectableSlugSet = useMemo(() => new Set(selectablePages.map((page) => page.slug)), [selectablePages]);
  const categoryTargets = useMemo(
    () => collectTocCategoryTargets(
      sections,
      pinned.flatMap((item) => item.type === "folder" ? [item.category] : []),
    ),
    [pinned, sections],
  );
  const personalSection = sections.find((section) => section.key === "personal");
  const primarySections = sections.filter((section) => section.key === "documents" || section.key === "knowledge");

  // 모바일: 목차를 off-canvas 드로어로. 데스크톱(md+)은 기존 고정 사이드바.
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [storedSelected, setStoredSelected] = useState<Set<string>>(() => new Set());
  const selected = useMemo(
    () => reconcileTocSelection(storedSelected, selectableSlugSet),
    [storedSelected, selectableSlugSet],
  );
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<{
    tone: "success" | "warning" | "error";
    message: string;
    showTrash: boolean;
  } | null>(null);
  const [bulkPending, startBulkTransition] = useTransition();
  const [movePending, startMoveTransition] = useTransition();
  const [movePendingCount, setMovePendingCount] = useState(0);
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveView, setMoveView] = useState<TocPageMoveView | null>(null);
  const [moveNotice, setMoveNotice] = useState<{
    tone: "success" | "warning" | "error";
    message: string;
    undo?: { receipts: PageCategoryMoveReceipt[]; expiresAt: number };
  } | null>(null);
  const interactionPending = bulkPending || movePending;
  const selectionDragRef = useRef<TocSelectionDrag | null>(null);
  const suppressCheckboxClickRef = useRef(false);
  const pageMoveGestureRef = useRef<TocPageMoveGesture | null>(null);
  const suppressMoveHandleClickRef = useRef(false);
  const [preferredTocWidth, setPreferredTocWidth] = useState(DEFAULT_WIKI_TOC_WIDTH);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const [resizingToc, setResizingToc] = useState(false);
  const preferredTocWidthRef = useRef(DEFAULT_WIKI_TOC_WIDTH);
  const resizeDragRef = useRef<TocResizeDrag | null>(null);
  const resizeBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const desktopTocWidth = viewportWidth === null
    ? DEFAULT_WIKI_TOC_WIDTH
    : displayedWikiTocWidth(preferredTocWidth, viewportWidth);
  const desktopTocMax = viewportWidth === null ? MAX_WIKI_TOC_WIDTH : wikiTocViewportMax(viewportWidth);
  const selectedRef = useRef(selected);
  const canonicalPagesRef = useRef(canonicalPages);
  const selectedPages = canonicalPages.filter((page) => selected.has(page.slug));
  const selectedCanMove = selectedPages.length === selected.size && selectedPages.length > 0 && selectedPages.every((page) => page.movable);
  const selectedCanTrash = selectedPages.length === selected.size && selectedPages.length > 0 && selectedPages.every((page) => page.trashable);

  const visibleSelectableSlugs = () =>
    [...(navRef.current?.querySelectorAll<HTMLElement>("[data-toc-select-slug]") ?? [])]
      .map((element) => element.dataset.tocSelectSlug)
      .filter((value): value is string => !!value && selectableSlugSet.has(value));

  const toggleSelectedPage = (pageSlug: string, shiftKey: boolean, allowRange: boolean) => {
    if (interactionPending || !selectableSlugSet.has(pageSlug)) return;
    setStoredSelected((previous) => {
      const clean = reconcileTocSelection(previous, selectableSlugSet);
      if (shiftKey && allowRange) {
        return addVisibleRange(clean, visibleSelectableSlugs(), selectionAnchor, pageSlug);
      }
      if (clean.has(pageSlug)) clean.delete(pageSlug);
      else clean.add(pageSlug);
      return clean;
    });
    setSelectionAnchor(allowRange ? pageSlug : null);
  };

  const toggleSelectedGroup = (slugs: readonly string[], value: boolean) => {
    if (interactionPending) return;
    setStoredSelected((previous) =>
      setTocGroupSelected(reconcileTocSelection(previous, selectableSlugSet), slugs, value),
    );
    setSelectionAnchor(null);
  };

  const paintSelectionDragSlug = (pageSlug: string) => {
    const drag = selectionDragRef.current;
    if (!drag || drag.visited.has(pageSlug) || !selectableSlugSet.has(pageSlug)) return;
    drag.visited.add(pageSlug);
    setStoredSelected((previous) =>
      setTocGroupSelected(reconcileTocSelection(previous, selectableSlugSet), [pageSlug], drag.value),
    );
  };

  const paintSelectionDragAt = (clientX: number, clientY: number) => {
    const row = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-toc-select-slug]");
    const pageSlug = row?.dataset.tocSelectSlug;
    if (pageSlug) paintSelectionDragSlug(pageSlug);
  };

  const runSelectionAutoScroll = () => {
    const drag = selectionDragRef.current;
    const nav = navRef.current;
    if (!drag || !nav) return;
    const rect = nav.getBoundingClientRect();
    const edge = 44;
    const topDistance = drag.clientY - rect.top;
    const bottomDistance = rect.bottom - drag.clientY;
    const delta = topDistance < edge
      ? -Math.ceil((edge - Math.max(0, topDistance)) / 4)
      : bottomDistance < edge
        ? Math.ceil((edge - Math.max(0, bottomDistance)) / 4)
        : 0;
    if (delta !== 0) {
      nav.scrollTop += delta;
      paintSelectionDragAt(drag.clientX, drag.clientY);
      drag.frame = window.requestAnimationFrame(runSelectionAutoScroll);
    } else {
      drag.frame = null;
    }
  };

  const scheduleSelectionAutoScroll = () => {
    const drag = selectionDragRef.current;
    if (drag && drag.frame === null) drag.frame = window.requestAnimationFrame(runSelectionAutoScroll);
  };

  const finishSelectionDrag = () => {
    const drag = selectionDragRef.current;
    if (!drag) return;
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    selectionDragRef.current = null;
  };

  const onCheckboxPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, pageSlug: string) => {
    if (interactionPending || event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    if (event.shiftKey) {
      suppressCheckboxClickRef.current = true;
      toggleSelectedPage(pageSlug, true, true);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressCheckboxClickRef.current = true;
    selectionDragRef.current = {
      pointerId: event.pointerId,
      value: !selected.has(pageSlug),
      visited: new Set(),
      clientX: event.clientX,
      clientY: event.clientY,
      frame: null,
    };
    setSelectionAnchor(pageSlug);
    paintSelectionDragSlug(pageSlug);
  };

  const onCheckboxPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    paintSelectionDragAt(event.clientX, event.clientY);
    scheduleSelectionAutoScroll();
  };

  const onCheckboxPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (selectionDragRef.current?.pointerId !== event.pointerId) return;
    finishSelectionDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onCheckboxPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (selectionDragRef.current?.pointerId !== event.pointerId) return;
    finishSelectionDrag();
    suppressCheckboxClickRef.current = false;
  };

  const onCheckboxLostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (selectionDragRef.current?.pointerId === event.pointerId) finishSelectionDrag();
  };

  const onCheckboxClick = (event: ReactMouseEvent<HTMLButtonElement>, pageSlug: string) => {
    if (suppressCheckboxClickRef.current && event.detail > 0) {
      suppressCheckboxClickRef.current = false;
      return;
    }
    suppressCheckboxClickRef.current = false;
    toggleSelectedPage(pageSlug, event.shiftKey, true);
  };

  const finishPageMoveGesture = (suppressClick: boolean): TocPageMoveGesture | null => {
    const gesture = pageMoveGestureRef.current;
    if (!gesture) return null;
    if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame);
    pageMoveGestureRef.current = null;
    setMoveView(null);
    if (suppressClick) {
      suppressMoveHandleClickRef.current = true;
      window.setTimeout(() => {
        suppressMoveHandleClickRef.current = false;
      }, 0);
    }
    return gesture;
  };

  const hitTestPageMove = () => {
    const gesture = pageMoveGestureRef.current;
    if (!gesture?.started || !gesture.payload) return;
    const element = document
      .elementFromPoint(gesture.clientX, gesture.clientY)
      ?.closest<HTMLElement>("[data-toc-drop-category]");
    let category: string | null | undefined;
    if (element?.hasAttribute("data-toc-drop-category")) {
      const value = element.getAttribute("data-toc-drop-category");
      category = value === "" ? null : value ?? undefined;
    }
    const targetState = category === undefined
      ? "invalid"
      : tocDropTargetState(gesture.payload.pages, category);
    gesture.targetCategory = category;
    gesture.targetState = targetState;
    setMoveView({
      pages: gesture.payload.pages,
      clientX: gesture.clientX,
      clientY: gesture.clientY,
      targetCategory: category,
      targetState,
    });
  };

  const runPageMoveAutoScroll = (timestamp: number) => {
    const gesture = pageMoveGestureRef.current;
    const nav = navRef.current;
    if (!gesture?.started || !nav) return;
    const rect = nav.getBoundingClientRect();
    if (gesture.clientX < rect.left || gesture.clientX > rect.right) {
      gesture.autoScrollDirection = 0;
      gesture.autoScrollStartedAt = null;
      gesture.frame = null;
      return;
    }
    const delta = tocEdgeAutoScrollDelta(gesture.clientY, rect.top, rect.bottom);
    if (delta === 0) {
      gesture.autoScrollDirection = 0;
      gesture.autoScrollStartedAt = null;
      gesture.frame = null;
      return;
    }
    const direction = delta < 0 ? -1 : 1;
    if (gesture.autoScrollDirection !== direction || gesture.autoScrollStartedAt === null) {
      gesture.autoScrollDirection = direction;
      gesture.autoScrollStartedAt = timestamp;
      gesture.frame = window.requestAnimationFrame(runPageMoveAutoScroll);
      return;
    }
    if (timestamp - gesture.autoScrollStartedAt < TOC_PAGE_MOVE_AUTO_SCROLL_DELAY_MS) {
      gesture.frame = window.requestAnimationFrame(runPageMoveAutoScroll);
      return;
    }
    const before = nav.scrollTop;
    nav.scrollTop += delta;
    if (nav.scrollTop === before) {
      gesture.autoScrollDirection = 0;
      gesture.autoScrollStartedAt = null;
      gesture.frame = null;
      return;
    }
    hitTestPageMove();
    gesture.frame = window.requestAnimationFrame(runPageMoveAutoScroll);
  };

  const schedulePageMoveAutoScroll = () => {
    const gesture = pageMoveGestureRef.current;
    if (gesture?.started && gesture.frame === null) {
      gesture.frame = window.requestAnimationFrame(runPageMoveAutoScroll);
    }
  };

  const requestPageMove = (
    items: readonly { slug: string; expectedVersion: number }[],
    category: string | null,
  ) => {
    if (interactionPending || items.length === 0) return;
    setMovePickerOpen(false);
    setBulkNotice(null);
    setMoveNotice(null);
    setMovePendingCount(items.length);
    startMoveTransition(async () => {
      try {
        const result = await movePagesToCategoryAction(slug, items, category, current ?? null);
        if (result.status === "error") {
          const message = result.code === "versionConflict"
            ? t("moveConflict")
            : result.code === "uncertain"
              ? t("moveUncertain")
              : t("moveFailed");
          setMoveNotice({ tone: "error", message });
          router.refresh();
          return;
        }
        setStoredSelected(new Set());
        setSelectionAnchor(null);
        setSelectionMode(false);
        setMoveNotice({
          tone: result.refreshRequired ? "warning" : "success",
          message: result.refreshRequired
            ? t("moveCleanupPending", { count: result.moved.length })
            : t("moveSuccess", { count: result.moved.length }),
          ...(result.moved.length > 0
            ? { undo: { receipts: result.moved, expiresAt: Date.now() + 10_000 } }
            : {}),
        });
        router.refresh();
      } catch {
        setMoveNotice({ tone: "error", message: t("moveUncertain") });
        router.refresh();
      }
    });
  };

  const requestPageMoveUndo = (receipts: readonly PageCategoryMoveReceipt[]) => {
    if (interactionPending || receipts.length === 0) return;
    setMovePendingCount(receipts.length);
    startMoveTransition(async () => {
      try {
        const result = await restorePageCategoriesAction(
          slug,
          receipts.map((item) => ({
            slug: item.slug,
            expectedVersion: item.newVersion,
            originalCategory: item.originalCategory,
          })),
          current ?? null,
        );
        if (result.status === "error") {
          setMoveNotice({
            tone: "error",
            message: result.code === "versionConflict" || result.code === "invalidUndo"
              ? t("undoConflict")
              : t("moveUncertain"),
          });
          router.refresh();
          return;
        }
        setMoveNotice({
          tone: result.refreshRequired ? "warning" : "success",
          message: result.refreshRequired ? t("undoCleanupPending") : t("undoSuccess"),
        });
        router.refresh();
      } catch {
        setMoveNotice({ tone: "error", message: t("moveUncertain") });
        router.refresh();
      }
    });
  };

  const onPageMovePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    page: TocSelectionPage,
  ) => {
    if (
      interactionPending ||
      event.pointerType === "touch" ||
      !event.isPrimary ||
      event.button !== 0 ||
      !page.movable
    ) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressMoveHandleClickRef.current = false;
    pageMoveGestureRef.current = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      grabbed: page,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      started: false,
      payload: null,
      targetCategory: undefined,
      targetState: "invalid",
      frame: null,
      autoScrollDirection: 0,
      autoScrollStartedAt: null,
    };
  };

  const onPageMovePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = pageMoveGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    if (!gesture.started) {
      if (!hasCrossedTocPageDragThreshold(
        { x: gesture.startX, y: gesture.startY },
        { x: event.clientX, y: event.clientY },
      )) return;
      const payload = tocPageMovePayloadForHandle(
        gesture.grabbed,
        canonicalPagesRef.current,
        selectedRef.current,
        selectionMode,
      );
      if (!payload) return;
      event.preventDefault();
      gesture.started = true;
      gesture.payload = payload;
      // 드래그 시작과 함께 root drop slot이 nav 위 flex 흐름에 삽입된다. 같은 pointermove에서
      // hit-test하면 삽입 전 좌표로 폴더를 강조한 뒤 다른 category로 drop할 수 있으므로,
      // 이 한 번의 시작 render만 동기 확정한다. 이후 pointer hop을 RAF까지 무시하지 않으면서
      // elementFromPoint가 표시된 레이아웃과 같은 좌표계를 사용하게 한다.
      flushSync(() => {
        if (payload.replaceSelection) {
          setStoredSelected(new Set([gesture.grabbed.slug]));
          setSelectionAnchor(gesture.grabbed.slug);
        }
        setMoveView({
          pages: payload.pages,
          clientX: gesture.clientX,
          clientY: gesture.clientY,
          targetCategory: undefined,
          targetState: "invalid",
        });
      });
      hitTestPageMove();
      schedulePageMoveAutoScroll();
      return;
    }
    hitTestPageMove();
    schedulePageMoveAutoScroll();
  };

  const onPageMovePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = pageMoveGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const started = gesture.started;
    const payload = gesture.payload;
    const category = gesture.targetCategory;
    const state = gesture.targetState;
    finishPageMoveGesture(started);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (started && payload && category !== undefined && state === "valid") {
      requestPageMove(payload.items, category);
    }
  };

  const onPageMovePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pageMoveGestureRef.current?.pointerId !== event.pointerId) return;
    finishPageMoveGesture(pageMoveGestureRef.current.started);
  };

  const onPageMoveLostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pageMoveGestureRef.current?.pointerId === event.pointerId) {
      finishPageMoveGesture(pageMoveGestureRef.current.started);
    }
  };

  const moveController: TocPageMoveController | undefined = canWrite
    ? {
        pending: interactionPending,
        dragging: moveView !== null,
        targetCategory: moveView?.targetCategory,
        targetState: (category) => moveView ? tocDropTargetState(moveView.pages, category) : "invalid",
        openSingle: (page) => quick?.openMove(page.slug, page.category, page.currentVersion),
        handleLabel: (pageTitle) => t("moveHandle", { title: pageTitle }),
        onPointerDown: onPageMovePointerDown,
        onPointerMove: onPageMovePointerMove,
        onPointerUp: onPageMovePointerUp,
        onPointerCancel: onPageMovePointerCancel,
        onLostPointerCapture: onPageMoveLostPointerCapture,
        suppressClick: (event) => {
          if (suppressMoveHandleClickRef.current && event.detail > 0) {
            suppressMoveHandleClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          suppressMoveHandleClickRef.current = false;
          return false;
        },
      }
    : undefined;

  const selectionView: TocSelectionView | undefined = selectionMode
    ? {
        selected,
        pending: interactionPending,
        pageLabel: (pageTitle) => t("selectPage", { title: pageTitle }),
        unavailableLabel: (pageTitle) => t("unavailablePage", { title: pageTitle }),
        groupLabel: (name, count) => t("selectGroup", { name, count }),
      }
    : undefined;

  const toggleSelectionMode = () => {
    if (interactionPending) return;
    setSelectionMode((value) => !value);
    setStoredSelected(new Set());
    setSelectionAnchor(null);
    setBulkNotice(null);
    finishSelectionDrag();
  };

  const closeMovePicker = useCallback(() => {
    if (!movePending) setMovePickerOpen(false);
  }, [movePending]);

  const requestBulkTrash = () => {
    if (interactionPending || selected.size === 0 || !selectedCanTrash) return;
    const items = [...selected].flatMap((pageSlug) => {
      const page = pageBySlug.get(pageSlug);
      return page ? [{ slug: page.slug, expectedVersion: page.currentVersion }] : [];
    });
    if (items.length === 0) return;
    const includesCurrent = !!current && selected.has(current);
    const confirmation = includesCurrent
      ? t("bulkTrashConfirmCurrent", { count: items.length })
      : t("bulkTrashConfirm", { count: items.length });
    if (!window.confirm(confirmation)) return;
    setBulkNotice(null);
    startBulkTransition(async () => {
      try {
        const result = await trashPagesFromTocAction(slug, items);
        const moved = new Set(
          result.items
            .filter((item) => item.outcome === "trashed" || item.outcome === "alreadyTrashed")
            .map((item) => item.slug),
        );
        setStoredSelected((previous) => {
          const next = reconcileTocSelection(previous, selectableSlugSet);
          for (const pageSlug of moved) next.delete(pageSlug);
          return next;
        });
        setSelectionAnchor(null);
        if (result.code === "invalidInput") {
          setBulkNotice({ tone: "error", message: t("bulkTrashInvalid"), showTrash: false });
        } else if (result.code === "failed") {
          setBulkNotice({ tone: "error", message: t("bulkTrashFailed"), showTrash: false });
        } else if (result.code === "uncertain") {
          setBulkNotice({ tone: "error", message: t("bulkTrashUncertain"), showTrash: result.movedCount > 0 });
        } else if (result.failedCount > 0) {
          setBulkNotice({
            tone: "warning",
            message: t("bulkTrashPartial", { moved: result.movedCount, failed: result.failedCount }),
            showTrash: result.movedCount > 0,
          });
        } else if (result.warningCount > 0) {
          setBulkNotice({
            tone: "warning",
            message: t("bulkTrashCleanupPending", { count: result.movedCount }),
            showTrash: true,
          });
        } else {
          setBulkNotice({
            tone: "success",
            message: t("bulkTrashSuccess", { count: result.movedCount }),
            showTrash: true,
          });
        }
        if (result.failedCount === 0 && result.code !== "invalidInput") setSelectionMode(false);
        if (current && moved.has(current)) router.push(`/wikis/${encodeURIComponent(slug)}`);
        else router.refresh();
      } catch {
        setBulkNotice({ tone: "error", message: t("bulkTrashUncertain"), showTrash: true });
        router.refresh();
      }
    });
  };

  const rememberPreferredTocWidth = (value: number, persist: boolean) => {
    const normalized = normalizeWikiTocWidth(value);
    preferredTocWidthRef.current = normalized;
    setPreferredTocWidth(normalized);
    if (!persist) return;
    try {
      localStorage.setItem(WIKI_TOC_WIDTH_STORAGE_KEY, String(normalized));
    } catch {
      // 저장소가 차단돼도 현재 탭의 조절 동작은 유지한다.
    }
  };

  const restoreResizeBodyStyles = () => {
    const previous = resizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    resizeBodyStyleRef.current = null;
  };

  const finishTocResize = () => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    setResizingToc(false);
    restoreResizeBodyStyles();
    rememberPreferredTocWidth(preferredTocWidthRef.current, true);
  };

  useEffect(() => {
    selectedRef.current = selected;
    canonicalPagesRef.current = canonicalPages;
  }, [canonicalPages, selected]);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    const restoreStoredWidth = (raw: string | null) => {
      const restored = parseStoredWikiTocWidth(raw);
      preferredTocWidthRef.current = restored;
      setPreferredTocWidth(restored);
    };
    try {
      restoreStoredWidth(localStorage.getItem(WIKI_TOC_WIDTH_STORAGE_KEY));
    } catch {
      restoreStoredWidth(null);
    }
    updateViewport();
    const onStorage = (event: StorageEvent) => {
      if (event.key === WIKI_TOC_WIDTH_STORAGE_KEY) restoreStoredWidth(event.newValue);
    };
    window.addEventListener("resize", updateViewport);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => () => {
    const selectionDrag = selectionDragRef.current;
    if (selectionDrag?.frame !== null && selectionDrag?.frame !== undefined) {
      window.cancelAnimationFrame(selectionDrag.frame);
    }
    selectionDragRef.current = null;
    const pageMove = pageMoveGestureRef.current;
    if (pageMove?.frame !== null && pageMove?.frame !== undefined) {
      window.cancelAnimationFrame(pageMove.frame);
    }
    pageMoveGestureRef.current = null;
    if (resizeDragRef.current) {
      try {
        localStorage.setItem(WIKI_TOC_WIDTH_STORAGE_KEY, String(preferredTocWidthRef.current));
      } catch {
        // 페이지 이탈 중 저장 실패는 무시한다.
      }
    }
    const previous = resizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    resizeBodyStyleRef.current = null;
  }, []);

  useEffect(() => {
    const undo = moveNotice?.undo;
    if (!undo) return;
    const remaining = Math.max(0, undo.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setMoveNotice((notice) => notice?.undo?.expiresAt === undo.expiresAt ? null : notice);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [moveNotice?.undo]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      const hidden = !media.matches && !open;
      drawer.inert = hidden;
      if (hidden) drawer.setAttribute("aria-hidden", "true");
      else drawer.removeAttribute("aria-hidden");
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia("(min-width: 768px)");
    const drawer = drawerRef.current;
    const toggle = toggleRef.current;
    if (media.matches || !drawer) return;

    const focusableSelector =
      'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      [...drawer.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => element.getClientRects().length > 0,
      );
    const focusFrame = window.requestAnimationFrame(() => {
      (focusable()[0] ?? drawer).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selectionMode) return;
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const onMediaChange = () => {
      if (media.matches) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    media.addEventListener("change", onMediaChange);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onMediaChange);
      if (!media.matches) toggle?.focus();
    };
  }, [open, selectionMode]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const storageKey = `jimi:toc-scroll:${slug}`;
    try {
      const saved = Number(sessionStorage.getItem(storageKey) ?? "0");
      if (Number.isFinite(saved) && saved >= 0) nav.scrollTop = saved;
    } catch {
      // 저장소가 차단된 브라우저에서도 목차 자체는 계속 동작한다.
    }
    const remember = () => {
      try {
        sessionStorage.setItem(storageKey, String(nav.scrollTop));
      } catch {
        // 저장 실패는 탐색 동작을 막지 않는다.
      }
    };
    nav.addEventListener("scroll", remember, { passive: true });
    return () => {
      remember();
      nav.removeEventListener("scroll", remember);
    };
  }, [slug]);

  return (
    <>
      {/* 모바일 전용 토글(☰/✕) — 사이드바 위(z-50)에 뜬다 */}
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("toggleToc")}
        aria-expanded={open}
        aria-controls="wiki-toc-drawer"
        tabIndex={open ? -1 : 0}
        className="fixed left-2 top-2 z-50 rounded-md border border-stone-200 bg-white/90 px-2.5 py-1.5 text-lg leading-none text-stone-700 shadow-sm backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 md:hidden"
      >
        {open ? "✕" : "☰"}
      </button>
      {/* 열렸을 때 배경(탭하면 닫힘) */}
      {open && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("toggleToc")}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}
      <aside
        id="wiki-toc-drawer"
        ref={drawerRef}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? title : undefined}
        aria-busy={interactionPending}
        tabIndex={open ? -1 : undefined}
        onKeyDown={(event) => {
          const pageMove = pageMoveGestureRef.current;
          if (event.key === "Escape" && pageMove) {
            event.preventDefault();
            event.stopPropagation();
            const { handle, pointerId, started } = pageMove;
            finishPageMoveGesture(started);
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
            return;
          }
          if (!selectionMode) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finishSelectionDrag();
            if (selected.size > 0) {
              setStoredSelected(new Set());
              setSelectionAnchor(null);
            } else if (!interactionPending) {
              setSelectionMode(false);
            }
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            toggleSelectedGroup(selectablePages.map((page) => page.slug), true);
            return;
          }
          if (event.key === "Delete" && selected.size > 0) {
            event.preventDefault();
            requestBulkTrash();
          }
        }}
        // 모바일 드로어에서 내부 링크(<a>)를 누르면 네비게이션과 함께 닫는다(폴더 토글 <button>은 유지).
        onClick={(e) => {
          if (open && (e.target as HTMLElement).closest("a")) setOpen(false);
        }}
        style={{ "--wiki-toc-width": `${desktopTocWidth}px` } as CSSProperties}
        className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-[min(88vw,22rem)] shrink-0 transform flex-col overscroll-contain border-r border-stone-200 bg-white transition-transform duration-200 md:relative md:z-auto md:w-[var(--wiki-toc-width)] md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
      <div className="border-b border-stone-100 px-3 py-3">
        <Link href="/wikis" className="text-xs text-stone-400 hover:text-stone-600">← {t("myWikis")}</Link>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
          <Tooltip label={title}>
            <Link href={`/wikis/${slug}`} className="min-w-0 truncate text-base font-bold tracking-tight">
              {title}
            </Link>
          </Tooltip>
          <div className="flex shrink-0 items-center gap-1">
            {canWrite ? (
              <button
                type="button"
                aria-pressed={selectionMode}
                disabled={selectablePages.length === 0 || interactionPending}
                onClick={toggleSelectionMode}
                className={`rounded-md border px-2 py-1 text-xs font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 ${
                  selectionMode
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                    : "border-stone-200 bg-white text-stone-500 hover:border-stone-300 hover:bg-stone-50 hover:text-stone-700"
                }`}
              >
                {selectionMode ? t("doneSelecting") : t("selectPages")}
              </button>
            ) : null}
            {!selectionMode ? (
              <RecentPopover
                slug={slug}
                current={current}
                heading={t("recentHeading")}
                emptyText={t("recentEmpty")}
                kindLabel={{
                  document: t("recentKind.document"),
                  concept: t("recentKind.concept"),
                  entity: t("recentKind.entity"),
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {movePending
          ? t("movePending", { count: movePendingCount })
          : moveView
            ? moveView.targetCategory === undefined
              ? t("draggingPages", { count: moveView.pages.length })
              : moveView.targetState === "valid"
                ? t("dragTarget", { target: moveView.targetCategory ?? t("inboxName") })
                : t("dragTargetUnavailable", { target: moveView.targetCategory ?? t("inboxName") })
            : bulkPending
              ? t("bulkTrashPending", { count: selected.size })
              : ""}
      </div>
      {moveNotice ? (
        <div
          role={moveNotice.tone === "error" ? "alert" : "status"}
          className={`mx-2 mt-2 flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs leading-5 ${
            moveNotice.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : moveNotice.tone === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <span className="min-w-0 flex-1">{moveNotice.message}</span>
          {moveNotice.undo ? (
            <button
              type="button"
              disabled={interactionPending}
              onClick={() => requestPageMoveUndo(moveNotice.undo!.receipts)}
              className="shrink-0 rounded-md border border-current/20 bg-white/70 px-2 py-1 font-semibold underline-offset-2 hover:bg-white hover:underline active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {movePending ? t("undoPending") : t("undo")}
            </button>
          ) : null}
        </div>
      ) : null}
      {bulkNotice ? (
        <div
          role={bulkNotice.tone === "error" ? "alert" : "status"}
          className={`mx-2 mt-2 rounded-lg border px-2.5 py-2 text-xs leading-5 ${
            bulkNotice.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : bulkNotice.tone === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <span>{bulkNotice.message}</span>
          {bulkNotice.showTrash ? (
            <Link
              href={`/wikis/${encodeURIComponent(slug)}/settings/trash`}
              className="ml-1 rounded font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t("viewTrash")}
            </Link>
          ) : null}
        </div>
      ) : null}

      {moveView ? (() => {
        const rootState = tocDropTargetState(moveView.pages, null);
        const rootTargeted = moveView.targetCategory === null;
        return (
          <div className="mx-2 mt-3 shrink-0">
            <button
              type="button"
              tabIndex={-1}
              data-toc-drop-category=""
              aria-disabled={rootState !== "valid"}
              className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-[background-color,border-color,color,box-shadow] motion-reduce:transition-none ${
                rootTargeted && rootState === "valid"
                  ? "border-indigo-300 bg-indigo-100 text-indigo-900 ring-2 ring-indigo-400 ring-offset-1"
                  : rootTargeted
                    ? "border-stone-200 bg-stone-100 text-stone-400"
                    : "border-dashed border-indigo-200 bg-indigo-50/60 text-indigo-700"
              }`}
            >
              <span aria-hidden="true">↥</span>
              <span>{t("moveToInboxDrop")}</span>
            </button>
          </div>
        );
      })() : null}

      <nav ref={navRef} className="flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
        {/* 고정 문서와 안정적인 사용자용 목차. 최근 기록은 헤더 팝오버에 격리한다. */}
        {pinned.length > 0 && (
          <div className="mb-3">
            <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{t("pinnedHeading")}</div>
            <ul className="space-y-0.5">
              {pinned.map((item) => {
                const canonical = item.type === "page" ? pageBySlug.get(item.slug) : undefined;
                const itemSelected = item.type === "page" && selected.has(item.slug);
                return (
                  <PinnedTocEntry
                    key={item.type === "folder" ? `f:${item.category}` : `p:${item.slug}`}
                    item={item}
                    slug={slug}
                    current={current}
                    selectionMode={selectionMode}
                    selected={itemSelected}
                    canonical={canonical}
                    pending={interactionPending}
                    canWrite={canWrite}
                    move={moveController}
                    moveView={moveView}
                    selectLabel={item.type === "page" ? t("selectPage", { title: item.title }) : ""}
                    onToggle={(shiftKey) => {
                      if (item.type === "page") toggleSelectedPage(item.slug, shiftKey, false);
                    }}
                  />
                );
              })}
            </ul>
          </div>
        )}

        {primarySections.length === 0 && !personalSection && pinned.length === 0 ? (
          <div className="px-2 py-2">
            <EmptyState asset="empty-pages" title={t("emptyTitle")} body={t("emptyBody")} compact />
          </div>
        ) : (
          <div className="space-y-4">
            {primarySections.map((s) => {
              const newKind = canWrite ? SECTION_NEW_KIND[s.key] : undefined;
              const sectionLabel = t(`section.${s.key}`);
              const sectionSlugs = selectableSlugsInEntries(s.entries, "either");
              const sectionSelection = tocGroupSelectionState(selected, sectionSlugs);
              const ctx: NodeCtx = {
                slug,
                current,
                newKind,
                canMove: canWrite,
                canTrash: canWrite,
                newInFolderLabel: (name) => t("newKindInFolder", { kind: t(`newKind.${s.key}`), name }),
                selection: selectionView,
                move: moveController,
              };
              return (
                <div key={s.key} className="group/section">
                  <div className="flex items-center gap-1 px-1 pb-1">
                    {selectionView ? (
                      <SelectionCheckbox
                        checked={sectionSelection.checked}
                        mixed={sectionSelection.mixed}
                        label={selectionView.groupLabel(sectionLabel, sectionSlugs.length)}
                        disabled={sectionSlugs.length === 0 || interactionPending}
                        onClick={() => toggleSelectedGroup(sectionSlugs, !sectionSelection.checked)}
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{sectionLabel}</span>
                    {!selectionMode && newKind && actions && (
                      <Tooltip label={t(`newKind.${s.key}`)}>
                        <button
                          type="button"
                          aria-label={t(`newKind.${s.key}`)}
                          onClick={() => actions.openNewPage({ kind: newKind })}
                          className="block shrink-0 rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                          +
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <ul className="space-y-0.5">
                    {s.entries.map((e) => (
                      <EntryNode
                        key={e.type === "folder" ? `f:${e.path}` : `p:${e.slug}`}
                        entry={e}
                        ctx={ctx}
                        depth={0}
                        parentPath=""
                        onTogglePage={toggleSelectedPage}
                        onToggleGroup={toggleSelectedGroup}
                        onCheckboxPointerDown={onCheckboxPointerDown}
                        onCheckboxPointerMove={onCheckboxPointerMove}
                        onCheckboxPointerUp={onCheckboxPointerUp}
                        onCheckboxPointerCancel={onCheckboxPointerCancel}
                        onCheckboxLostPointerCapture={onCheckboxLostPointerCapture}
                        onCheckboxClick={onCheckboxClick}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
            {personalSection ? (
              <SecondarySection
                section={personalSection}
                label={t("section.personal")}
                ctx={{
                  slug,
                  current,
                  newKind: canWrite ? SECTION_NEW_KIND.personal : undefined,
                  canMove: canWrite,
                  canTrash: canWrite,
                  newInFolderLabel: (name) => t("newKindInFolder", { kind: t("newKind.personal"), name }),
                  selection: selectionView,
                  move: moveController,
                }}
                onTogglePage={toggleSelectedPage}
                onToggleGroup={toggleSelectedGroup}
                onCheckboxPointerDown={onCheckboxPointerDown}
                onCheckboxPointerMove={onCheckboxPointerMove}
                onCheckboxPointerUp={onCheckboxPointerUp}
                onCheckboxPointerCancel={onCheckboxPointerCancel}
                onCheckboxLostPointerCapture={onCheckboxLostPointerCapture}
                onCheckboxClick={onCheckboxClick}
              />
            ) : null}
          </div>
        )}
      </nav>

      {selectionMode ? (
        <div
          role="region"
          aria-label={t("selectionActions")}
          className="border-t border-indigo-100 bg-indigo-50/70 px-3 py-3 shadow-[0_-8px_20px_-18px_rgba(79,70,229,0.7)]"
        >
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm font-semibold text-indigo-950">
              {t("selectedCount", { count: selected.size })}
            </div>
            <div className="text-[11px] text-stone-500">
              {t("selectableCount", { count: selectablePages.length })}
            </div>
          </div>
          {canonicalPages.length > selectablePages.length ? (
            <div className="mt-0.5 text-[11px] text-stone-500">
              {t("excludedCount", { count: canonicalPages.length - selectablePages.length })}
            </div>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              disabled={interactionPending || selectablePages.length === 0}
              onClick={() =>
                toggleSelectedGroup(
                  selectablePages.map((page) => page.slug),
                  selected.size !== selectablePages.length,
                )
              }
              className="rounded-md border border-indigo-200 bg-white px-2 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 active:bg-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {selected.size === selectablePages.length ? t("clearAll") : t("selectAll")}
            </button>
            <button
              type="button"
              disabled={interactionPending || selected.size === 0}
              onClick={() => {
                setStoredSelected(new Set());
                setSelectionAnchor(null);
              }}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 active:bg-stone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {t("clearSelection")}
            </button>
          </div>
          <button
            type="button"
            disabled={interactionPending || !selectedCanMove}
            onClick={() => setMovePickerOpen(true)}
            className="mt-2 flex w-full items-center justify-center rounded-md border border-indigo-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 transition-colors motion-reduce:transition-none hover:border-indigo-300 hover:bg-indigo-100 active:bg-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {movePending ? t("movePending", { count: selected.size }) : t("bulkMoveButton", { count: selected.size })}
          </button>
          <button
            type="button"
            disabled={interactionPending || !selectedCanTrash}
            onClick={requestBulkTrash}
            className="mt-2 flex w-full items-center justify-center rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 transition-colors motion-reduce:transition-none hover:border-rose-300 hover:bg-rose-100 active:bg-rose-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {bulkPending ? t("bulkTrashPending", { count: selected.size }) : t("bulkTrashButton", { count: selected.size })}
          </button>
          <p className="mt-1.5 text-[11px] leading-4 text-stone-500">
            <span className="hidden md:inline">{t("selectionHintDesktop")}</span>
            <span className="md:hidden">{t("selectionHintMobile")}</span>
          </p>
        </div>
      ) : (
      <div className="border-t border-stone-100 px-2 py-2">
        <ul className="space-y-0.5">
          <li>
            {/* 링크 폴백: hydration 전엔 /chat 페이지로 이동, 후엔 클릭을 가로채 모달 오픈 */}
            <Link
              href={`/wikis/${slug}/chat`}
              onClick={(e) => {
                if (chatModal) {
                  e.preventDefault();
                  chatModal.open();
                }
              }}
              className={`flex w-full items-center px-2 ${linkCls(sub === "chat")}`}
            >
              <span className="min-w-0 flex-1 truncate">{t("askAi")}</span>
              <kbd className="rounded border border-stone-200 bg-stone-50 px-1 text-[10px] text-stone-400">{shortcut} · /</kbd>
            </Link>
          </li>
          {quick && (
            <li>
              <button
                type="button"
                onClick={() => quick.openSwitcher()}
                className={`flex w-full items-center px-2 ${linkCls(false)}`}
              >
                <span className="min-w-0 flex-1 truncate text-left">{t("quickSwitch")}</span>
                <kbd className="rounded border border-stone-200 bg-stone-50 px-1 text-[10px] text-stone-400">{isMac ? "⌘P" : "Ctrl+P"}</kbd>
              </button>
            </li>
          )}
          {quick && canWrite && (
            <li>
              <button
                type="button"
                onClick={() => quick.openCapture()}
                className={`flex w-full items-center px-2 ${linkCls(false)}`}
              >
                <span className="min-w-0 flex-1 truncate text-left">{t("quickCapture")}</span>
                <kbd className="rounded border border-stone-200 bg-stone-50 px-1 text-[10px] text-stone-400">{isMac ? "⌘⇧N" : "Ctrl+⇧N"}</kbd>
              </button>
            </li>
          )}
          {role !== "viewer" && (
            <li>
              {/* 모달로 즉시 오픈. JS 없으면 /new 페이지로 폴백. */}
              <Link
                href={`/wikis/${slug}/new`}
                onClick={(e) => {
                  if (actions) {
                    e.preventDefault();
                    actions.openNewPage();
                  }
                }}
                className={`px-2 ${linkCls(sub === "new")}`}
              >
                + {t("newPage")}
              </Link>
            </li>
          )}
          {role !== "viewer" && (
            <li>
              {/* 소스 편입 모달. hydration 전에는 전용 전체 페이지로 이동한다. */}
              <Link
                href={`/wikis/${slug}/ingest`}
                onClick={(e) => {
                  if (actions) {
                    e.preventDefault();
                    actions.openIngest();
                  }
                }}
                className={`px-2 ${linkCls(sub === "ingest")}`}
              >
                + {t("ingestSource")}
              </Link>
            </li>
          )}
          <li>
            <Link href={`/wikis/${slug}/reading`} className={`px-2 ${linkCls(sub === "reading")}`}>{t("readingList")}</Link>
          </li>
          <li>
            <Link href={`/wikis/${slug}/sources`} className={`px-2 ${linkCls(sub === "sources")}`}>{t("sourceArchive")}</Link>
          </li>
          <li className="pt-1">
            <details
              className="group/manage"
              open={["graph", "builds", "lint", "docs", "settings"].includes(sub ?? "") ? true : undefined}
            >
              <summary className="flex cursor-pointer list-none items-center rounded-md px-2 py-1 text-sm text-stone-500 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">{t("manage")}</span>
                <span className="text-xs text-stone-400 transition-transform motion-reduce:transition-none group-open/manage:rotate-90" aria-hidden="true">›</span>
              </summary>
              <ul className="mt-1 space-y-0.5 border-l border-stone-200 pl-2">
                <li>
                  <Link href={`/wikis/${slug}/graph`} className={`px-2 ${linkCls(sub === "graph")}`}>{t("graph")}</Link>
                </li>
                {role !== "viewer" ? (
                  <>
                    <li>
                      <Link href={`/wikis/${slug}/builds`} className={`px-2 ${linkCls(sub === "builds")}`}>{t("builds")}</Link>
                    </li>
                    <li>
                      <Link href={`/wikis/${slug}/lint`} className={`px-2 ${linkCls(sub === "lint")}`}>{t("healthCheck")}</Link>
                    </li>
                  </>
                ) : null}
                <li>
                  <Link href={`/wikis/${encodeURIComponent(slug)}/docs`} className={`px-2 ${linkCls(sub === "docs")}`}>{t("integrationGuide")}</Link>
                </li>
                <li>
                  <Link href={`/wikis/${encodeURIComponent(slug)}/settings/trash`} className={`px-2 ${linkCls(inTrash)}`}>{t("trash")}</Link>
                </li>
                {role === "owner" ? (
                  <li>
                    <Link href={`/wikis/${slug}/settings`} className={`px-2 ${linkCls(sub === "settings" && !inTrash)}`}>{t("settings")}</Link>
                  </li>
                ) : null}
              </ul>
            </details>
          </li>
        </ul>
      </div>
      )}

      <div className="border-t border-stone-200 px-3 py-2">
        <div className="mb-1 truncate px-1 text-xs text-stone-500">{email}</div>
        {showLogout ? (
          <form action={logoutAction}>
            <button className="w-full rounded-md px-2 py-1 text-left text-sm text-stone-600 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("logout")}</button>
          </form>
        ) : null}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resizeToc")}
        aria-valuemin={MIN_WIKI_TOC_WIDTH}
        aria-valuemax={desktopTocMax}
        aria-valuenow={desktopTocWidth}
        aria-valuetext={t("resizeTocValue", { width: desktopTocWidth })}
        title={t("resizeTocHint")}
        tabIndex={0}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: desktopTocWidth,
          };
          resizeBodyStyleRef.current = {
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
          };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          setResizingToc(true);
        }}
        onPointerMove={(event) => {
          const drag = resizeDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const next = displayedWikiTocWidth(drag.startWidth + event.clientX - drag.startX, window.innerWidth);
          rememberPreferredTocWidth(next, false);
        }}
        onPointerUp={(event) => {
          if (resizeDragRef.current?.pointerId !== event.pointerId) return;
          finishTocResize();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (resizeDragRef.current?.pointerId === event.pointerId) finishTocResize();
        }}
        onLostPointerCapture={finishTocResize}
        onDoubleClick={() => rememberPreferredTocWidth(DEFAULT_WIKI_TOC_WIDTH, true)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          const step = event.shiftKey ? 48 : 16;
          const next = displayedWikiTocWidth(desktopTocWidth + direction * step, window.innerWidth);
          rememberPreferredTocWidth(next, true);
        }}
        className={`group/toc-resizer absolute inset-y-0 -right-1 z-20 hidden w-2 touch-none cursor-col-resize select-none outline-none md:block md:hover:bg-indigo-50/60 md:focus-visible:bg-indigo-50/80 md:active:bg-indigo-100/70 ${
          resizingToc ? "bg-indigo-100/70" : ""
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm transition-colors motion-reduce:transition-none group-hover/toc-resizer:bg-indigo-300 group-focus-visible/toc-resizer:bg-indigo-500 group-active/toc-resizer:bg-indigo-500 ${
            resizingToc ? "bg-indigo-500" : "bg-stone-300"
          }`}
        />
      </div>
      </aside>
      <Modal open={movePickerOpen} onClose={closeMovePicker} title={t("movePickerTitle", { count: selected.size })}>
        <p className="mb-3 text-sm leading-6 text-stone-500">{t("movePickerDescription")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {categoryTargets.map((category, index) => {
            const targetState = tocDropTargetState(selectedPages, category);
            const disabled = interactionPending || targetState !== "valid";
            return (
              <button
                key={category ?? "__root__"}
                type="button"
                data-autofocus={index === 0 && !disabled ? true : undefined}
                disabled={disabled}
                onClick={() => requestPageMove(
                  selectedPages.map((page) => ({ slug: page.slug, expectedVersion: page.currentVersion })),
                  category,
                )}
                className={`flex min-h-12 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-[background-color,border-color,color,transform] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  targetState === "valid"
                    ? "border-stone-200 bg-white text-stone-700 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-800 active:translate-y-px active:bg-indigo-100"
                    : "cursor-not-allowed border-stone-100 bg-stone-50 text-stone-400"
                }`}
              >
                <span aria-hidden="true" className="shrink-0 text-stone-400">{category ? "▸" : "↥"}</span>
                <span className="min-w-0 flex-1 truncate">{category ?? t("inboxName")}</span>
                {targetState === "current" ? <span className="text-[10px] font-medium">{t("currentFolder")}</span> : null}
              </button>
            );
          })}
        </div>
      </Modal>
      {moveView ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none fixed z-[60] flex max-w-64 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold shadow-xl backdrop-blur-sm ${
            moveView.targetState === "valid"
              ? "border-indigo-300 bg-indigo-600/95 text-white ring-2 ring-indigo-200"
              : "border-stone-300 bg-stone-100/95 text-stone-500"
          }`}
          style={{ left: moveView.clientX + 14, top: moveView.clientY + 14 }}
        >
          <span className="truncate">
            {moveView.pages.length === 1 ? moveView.pages[0].title : t("dragPreviewCount", { count: moveView.pages.length })}
          </span>
          {moveView.pages.length > 1 ? (
            <span className="rounded-full bg-white/20 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">{moveView.pages.length}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
