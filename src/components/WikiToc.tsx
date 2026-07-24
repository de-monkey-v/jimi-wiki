"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { logoutAction } from "@/app/login/actions";
import { useChatModal, useShortcutLabel } from "@/app/wikis/[slug]/chat/ChatModal";
import { useWikiActions } from "@/app/wikis/[slug]/WikiActions";
import { useQuickNav } from "@/app/wikis/[slug]/QuickNav";
import { RecentList } from "@/app/wikis/[slug]/RecentList";
import { EmptyState } from "@/components/EmptyState";
import { Tooltip } from "@/components/ui/Tooltip";
import type { TocSection, TocEntry } from "@/lib/kinds";
import { isReservedWikiPageSlug } from "@/lib/wiki-routes";

type PinnedItem =
  | { type: "page"; slug: string; title: string }
  | { type: "folder"; category: string };

function linkCls(active: boolean) {
  return `block truncate rounded-md py-1 pr-2 text-sm ${
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
// movable: 개인 노트처럼 폴더 이동 버튼을 붙일지. parentPath: 이동 시 프리필할 현재 폴더 경로.
type NodeCtx = {
  slug: string;
  current: string | undefined;
  newKind?: string;
  movable?: boolean;
  moveLabel: string;
  newInFolderLabel: (name: string) => string;
};

function EntryNode({ entry, ctx, depth, parentPath }: { entry: TocEntry; ctx: NodeCtx; depth: number; parentPath: string }) {
  const quick = useQuickNav();
  if (entry.type === "page") {
    return (
      <li className="group/leaf relative">
        <Link href={`/wikis/${ctx.slug}/${entry.slug}`} className={linkCls(entry.slug === ctx.current)} style={{ paddingLeft: depth * 12 + 20 }}>
          {entry.title}
        </Link>
        {ctx.movable && quick && (
          <Tooltip label={ctx.moveLabel}>
            <button
              type="button"
              aria-label={ctx.moveLabel}
              onClick={(e) => {
                e.stopPropagation();
                quick.openMove(entry.slug, parentPath || null, entry.currentVersion);
              }}
              className="absolute right-1 top-1/2 block -translate-y-1/2 rounded px-1 text-xs text-stone-400 hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              ⋯
            </button>
          </Tooltip>
        )}
      </li>
    );
  }
  return <FolderNode entry={entry} ctx={ctx} depth={depth} />;
}

function FolderNode({ entry, ctx, depth }: { entry: Extract<TocEntry, { type: "folder" }>; ctx: NodeCtx; depth: number }) {
  const actions = useWikiActions();
  const active = entryHasSlug(entry, ctx.current);
  const [override, setOverride] = useState<{ open: boolean; whenActive: boolean } | null>(null);
  const open = override && override.whenActive === active ? override.open : active || depth < 1;
  return (
    <li>
      <div className="group/folder flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOverride({ open: !open, whenActive: active })}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pr-2 text-sm text-stone-500 hover:bg-stone-100"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <span className="w-3 shrink-0 text-xs text-stone-400">{open ? "▾" : "▸"}</span>
          <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
          <span className="text-xs text-stone-300">{leafCount(entry)}</span>
        </button>
        {ctx.newKind && actions && (
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// 섹션별 "+" 새 노트 kind. 원문/소스(sources)는 ingest 전용이라 "+" 없음.
const SECTION_NEW_KIND: Record<TocSection["key"], string | undefined> = {
  personal: "personal",
  documents: "document",
  knowledge: "concept",
  sources: undefined,
};

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
  const chatModal = useChatModal();
  const actions = useWikiActions();
  const quick = useQuickNav();
  const shortcut = useShortcutLabel();
  const isMac = shortcut.startsWith("⌘");
  const canWrite = role !== "viewer";

  // 모바일: 목차를 off-canvas 드로어로. 데스크톱(md+)은 기존 고정 사이드바.
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

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

  return (
    <>
      {/* 모바일 전용 토글(☰/✕) — 사이드바 위(z-50)에 뜬다 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("toggleToc")}
        aria-expanded={open}
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
        ref={drawerRef}
        // 모바일 드로어에서 내부 링크(<a>)를 누르면 네비게이션과 함께 닫는다(폴더 토글 <button>은 유지).
        onClick={(e) => {
          if (open && (e.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-72 shrink-0 transform flex-col overflow-x-hidden border-r border-stone-200 bg-white transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
      <div className="border-b border-stone-100 px-3 py-3">
        <Link href="/wikis" className="text-xs text-stone-400 hover:text-stone-600">← {t("myWikis")}</Link>
        <Link href={`/wikis/${slug}`} className="mt-1 block truncate text-base font-bold tracking-tight">
          {title}
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {/* 고정(핀) + 최근 본 문서 — 직접 접근 블록 */}
        {pinned.length > 0 && (
          <div className="mb-3">
            <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{t("pinnedHeading")}</div>
            <ul className="space-y-0.5">
              {pinned.map((p) =>
                p.type === "folder" ? (
                  <li key={`f:${p.category}`}>
                    <Link
                      href={`/wikis/${slug}/category/${p.category.split("/").map(encodeURIComponent).join("/")}`}
                      className={`flex items-center gap-1 ${linkCls(false)}`}
                      style={{ paddingLeft: 20 }}
                    >
                      <span className="shrink-0 text-stone-400">📁</span>
                      <span className="min-w-0 flex-1 truncate">{p.category.split("/").pop()}</span>
                    </Link>
                  </li>
                ) : (
                  <li key={`p:${p.slug}`}>
                    <Link href={`/wikis/${slug}/${p.slug}`} className={`flex items-center gap-1 ${linkCls(p.slug === current)}`} style={{ paddingLeft: 20 }}>
                      <span className="shrink-0 text-amber-500">★</span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
        <RecentList slug={slug} current={current} heading={t("recentHeading")} />

        {sections.length === 0 && pinned.length === 0 ? (
          <div className="px-2 py-2">
            <EmptyState asset="empty-pages" title={t("emptyTitle")} body={t("emptyBody")} compact />
          </div>
        ) : (
          <div className="space-y-4">
            {sections.map((s) => {
              const newKind = canWrite ? SECTION_NEW_KIND[s.key] : undefined;
              const ctx: NodeCtx = {
                slug,
                current,
                newKind,
                movable: canWrite && s.key === "personal",
                moveLabel: t("movePage"),
                newInFolderLabel: (name) => t("newKindInFolder", { kind: t(`newKind.${s.key}`), name }),
              };
              return (
                <div key={s.key} className="group/section">
                  <div className="flex items-center px-1 pb-1">
                    <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{t(`section.${s.key}`)}</span>
                    {newKind && actions && (
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
                      <EntryNode key={e.type === "folder" ? `f:${e.path}` : `p:${e.slug}`} entry={e} ctx={ctx} depth={0} parentPath="" />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </nav>

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
            <Link href={`/wikis/${slug}/graph`} className={`px-2 ${linkCls(sub === "graph")}`}>{t("graph")}</Link>
          </li>
          <li>
            <Link href={`/wikis/${slug}/reading`} className={`px-2 ${linkCls(sub === "reading")}`}>{t("readingList")}</Link>
          </li>
          {role !== "viewer" && (
            <li>
              <Link href={`/wikis/${slug}/builds`} className={`px-2 ${linkCls(sub === "builds")}`}>{t("builds")}</Link>
            </li>
          )}
          {role !== "viewer" && (
            <li>
              <Link href={`/wikis/${slug}/lint`} className={`px-2 ${linkCls(sub === "lint")}`}>{t("healthCheck")}</Link>
            </li>
          )}
          <li>
            <Link href={`/wikis/${encodeURIComponent(slug)}/docs`} className={`px-2 ${linkCls(sub === "docs")}`}>{t("integrationGuide")}</Link>
          </li>
          <li>
            <Link href={`/wikis/${encodeURIComponent(slug)}/settings/trash`} className={`px-2 ${linkCls(inTrash)}`}>{t("trash")}</Link>
          </li>
          {role === "owner" && (
            <li>
              <Link href={`/wikis/${slug}/settings`} className={`px-2 ${linkCls(sub === "settings" && !inTrash)}`}>{t("settings")}</Link>
            </li>
          )}
        </ul>
      </div>

      <div className="border-t border-stone-200 px-3 py-2">
        <div className="mb-1 truncate px-1 text-xs text-stone-500">{email}</div>
        {showLogout ? (
          <form action={logoutAction}>
            <button className="w-full rounded-md px-2 py-1 text-left text-sm text-stone-600 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("logout")}</button>
          </form>
        ) : null}
      </div>
      </aside>
    </>
  );
}
