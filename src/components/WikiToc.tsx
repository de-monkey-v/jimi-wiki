"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { logoutAction } from "@/app/login/actions";
import { useChatModal, useShortcutLabel } from "@/app/wikis/[slug]/chat/ChatModal";
import { trashPagesFromTocAction } from "@/app/wikis/[slug]/knowledge-controls-actions";
import { useWikiActions } from "@/app/wikis/[slug]/WikiActions";
import { useQuickNav } from "@/app/wikis/[slug]/QuickNav";
import { RecentPopover } from "@/app/wikis/[slug]/RecentList";
import { EmptyState } from "@/components/EmptyState";
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
// movable: 개인 노트처럼 폴더 이동 항목을 붙일지. canTrash: 휴지통 항목(역할 조건, 행별 trashable과 AND).
// parentPath: 이동 시 프리필할 현재 폴더 경로.
type NodeCtx = {
  slug: string;
  current: string | undefined;
  newKind?: string;
  movable?: boolean;
  canTrash: boolean;
  newInFolderLabel: (name: string) => string;
  selection?: TocSelectionView;
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

function EntryNode({
  entry,
  ctx,
  depth,
  parentPath,
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
      return (
        <li
          data-toc-select-slug={entry.trashable ? entry.slug : undefined}
          className={`relative rounded-md border-l-2 transition-colors motion-reduce:transition-none ${
            selected ? "border-indigo-500 bg-indigo-50 text-indigo-950" : "border-transparent hover:bg-stone-50"
          }`}
        >
          <div className="flex min-h-9 items-center gap-1.5 pr-1" style={{ paddingLeft: depth * 12 + 4 }}>
            <SelectionCheckbox
              checked={selected}
              label={entry.trashable ? ctx.selection.pageLabel(entry.title) : ctx.selection.unavailableLabel(entry.title)}
              disabled={!entry.trashable || ctx.selection.pending}
              draggable={entry.trashable}
              onClick={(event) => onCheckboxClick?.(event, entry.slug)}
              onPointerDown={entry.trashable ? (event) => onCheckboxPointerDown?.(event, entry.slug) : undefined}
              onPointerMove={entry.trashable ? onCheckboxPointerMove : undefined}
              onPointerUp={entry.trashable ? onCheckboxPointerUp : undefined}
              onPointerCancel={entry.trashable ? onCheckboxPointerCancel : undefined}
              onLostPointerCapture={entry.trashable ? onCheckboxLostPointerCapture : undefined}
            />
            <button
              type="button"
              disabled={!entry.trashable || ctx.selection.pending}
              onClick={(event) => onTogglePage?.(entry.slug, event.shiftKey, true)}
              className={`min-w-0 flex-1 rounded px-1 py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:bg-indigo-100 disabled:cursor-not-allowed ${
                entry.trashable ? "text-stone-700 hover:text-stone-950" : "text-stone-400"
              }`}
            >
              <span className="line-clamp-2 md:block md:truncate">{entry.title}</span>
            </button>
          </div>
        </li>
      );
    }
    return (
      <li className="group/leaf relative">
        <Tooltip label={entry.title}>
          <Link href={`/wikis/${ctx.slug}/${entry.slug}`} className={linkCls(entry.slug === ctx.current, true)} style={{ paddingLeft: depth * 12 + 20 }}>
            {entry.title}
          </Link>
        </Tooltip>
        <PageKebabMenu
          wikiSlug={ctx.slug}
          pageSlug={entry.slug}
          currentVersion={entry.currentVersion}
          currentCategory={parentPath || null}
          canMove={!!ctx.movable}
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
  const selectableSlugs = selectableSlugsInEntries(entry.children);
  const selectionState = ctx.selection ? tocGroupSelectionState(ctx.selection.selected, selectableSlugs) : null;
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
            onClick={() => setOverride({ open: !open, whenActive: active })}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pr-2 text-sm text-stone-500 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
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
  const selectableSlugs = selectableSlugsInEntries(section.entries);
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
  const selectablePages = useMemo(() => canonicalPages.filter((page) => page.trashable), [canonicalPages]);
  const selectableSlugSet = useMemo(() => new Set(selectablePages.map((page) => page.slug)), [selectablePages]);
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
  const selectionDragRef = useRef<TocSelectionDrag | null>(null);
  const suppressCheckboxClickRef = useRef(false);
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

  const visibleSelectableSlugs = () =>
    [...(navRef.current?.querySelectorAll<HTMLElement>("[data-toc-select-slug]") ?? [])]
      .map((element) => element.dataset.tocSelectSlug)
      .filter((value): value is string => !!value && selectableSlugSet.has(value));

  const toggleSelectedPage = (pageSlug: string, shiftKey: boolean, allowRange: boolean) => {
    if (bulkPending || !selectableSlugSet.has(pageSlug)) return;
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
    if (bulkPending) return;
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
    if (bulkPending || event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
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

  const selectionView: TocSelectionView | undefined = selectionMode
    ? {
        selected,
        pending: bulkPending,
        pageLabel: (pageTitle) => t("selectPage", { title: pageTitle }),
        unavailableLabel: (pageTitle) => t("unavailablePage", { title: pageTitle }),
        groupLabel: (name, count) => t("selectGroup", { name, count }),
      }
    : undefined;

  const toggleSelectionMode = () => {
    if (bulkPending) return;
    setSelectionMode((value) => !value);
    setStoredSelected(new Set());
    setSelectionAnchor(null);
    setBulkNotice(null);
    finishSelectionDrag();
  };

  const requestBulkTrash = () => {
    if (bulkPending || selected.size === 0) return;
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
        aria-busy={bulkPending}
        tabIndex={open ? -1 : undefined}
        onKeyDown={(event) => {
          if (!selectionMode) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finishSelectionDrag();
            if (selected.size > 0) {
              setStoredSelected(new Set());
              setSelectionAnchor(null);
            } else if (!bulkPending) {
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
                disabled={selectablePages.length === 0 || bulkPending}
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
        {bulkPending ? t("bulkTrashPending", { count: selected.size }) : ""}
      </div>
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

      <nav ref={navRef} className="flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
        {/* 고정 문서와 안정적인 사용자용 목차. 최근 기록은 헤더 팝오버에 격리한다. */}
        {pinned.length > 0 && (
          <div className="mb-3">
            <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{t("pinnedHeading")}</div>
            <ul className="space-y-0.5">
              {pinned.map((p) => {
                if (p.type === "folder") {
                  const folderName = p.category.split("/").pop() ?? p.category;
                  return (
                    <li key={`f:${p.category}`}>
                      <Tooltip label={folderName}>
                        {selectionMode ? (
                          <div className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sm text-stone-400" aria-disabled="true">
                            <span className="shrink-0">📁</span>
                            <span className="min-w-0 flex-1 truncate">{folderName}</span>
                          </div>
                        ) : (
                          <Link
                            href={`/wikis/${slug}/category/${p.category.split("/").map(encodeURIComponent).join("/")}`}
                            className={`flex items-center gap-1 ${linkCls(false)}`}
                            style={{ paddingLeft: 20 }}
                          >
                            <span className="shrink-0 text-stone-400">📁</span>
                            <span className="min-w-0 flex-1 truncate">{folderName}</span>
                          </Link>
                        )}
                      </Tooltip>
                    </li>
                  );
                }
                const canonical = pageBySlug.get(p.slug);
                const pinnedSelected = selected.has(p.slug);
                return (
                  <li
                    key={`p:${p.slug}`}
                    className={selectionMode && pinnedSelected ? "rounded-md bg-indigo-50" : undefined}
                  >
                    <Tooltip label={p.title}>
                      {selectionMode && canonical?.trashable ? (
                        <div className="flex min-h-8 items-center gap-1.5 rounded-md px-1">
                          <SelectionCheckbox
                            checked={pinnedSelected}
                            label={t("selectPage", { title: p.title })}
                            disabled={bulkPending}
                            onClick={(event) => toggleSelectedPage(p.slug, event.shiftKey, false)}
                          />
                          <button
                            type="button"
                            disabled={bulkPending}
                            onClick={(event) => toggleSelectedPage(p.slug, event.shiftKey, false)}
                            className="min-w-0 flex-1 rounded px-1 py-1 text-left text-sm text-stone-700 hover:bg-indigo-100 active:bg-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed"
                          >
                            <span className="mr-1 text-amber-500" aria-hidden="true">★</span>
                            <span className="line-clamp-2 md:inline md:truncate">{p.title}</span>
                          </button>
                        </div>
                      ) : selectionMode ? (
                        <div className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sm text-stone-400" aria-disabled="true">
                          <span className="shrink-0 text-amber-400">★</span>
                          <span className="min-w-0 flex-1 line-clamp-2 md:block md:truncate">{p.title}</span>
                        </div>
                      ) : (
                        <Link href={`/wikis/${slug}/${p.slug}`} className={`flex items-center gap-1 ${linkCls(p.slug === current)}`} style={{ paddingLeft: 20 }}>
                          <span className="shrink-0 text-amber-500">★</span>
                          <span className="min-w-0 flex-1 whitespace-normal line-clamp-2 md:block md:truncate">{p.title}</span>
                        </Link>
                      )}
                    </Tooltip>
                  </li>
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
              const sectionSlugs = selectableSlugsInEntries(s.entries);
              const sectionSelection = tocGroupSelectionState(selected, sectionSlugs);
              const ctx: NodeCtx = {
                slug,
                current,
                newKind,
                movable: canWrite && s.key === "personal",
                canTrash: canWrite,
                newInFolderLabel: (name) => t("newKindInFolder", { kind: t(`newKind.${s.key}`), name }),
                selection: selectionView,
              };
              return (
                <div key={s.key} className="group/section">
                  <div className="flex items-center gap-1 px-1 pb-1">
                    {selectionView ? (
                      <SelectionCheckbox
                        checked={sectionSelection.checked}
                        mixed={sectionSelection.mixed}
                        label={selectionView.groupLabel(sectionLabel, sectionSlugs.length)}
                        disabled={sectionSlugs.length === 0 || bulkPending}
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
                  movable: canWrite,
                  canTrash: canWrite,
                  newInFolderLabel: (name) => t("newKindInFolder", { kind: t("newKind.personal"), name }),
                  selection: selectionView,
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
              disabled={bulkPending || selectablePages.length === 0}
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
              disabled={bulkPending || selected.size === 0}
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
            disabled={bulkPending || selected.size === 0}
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
    </>
  );
}
