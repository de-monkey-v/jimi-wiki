"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { parseRecentPages, recentKey, type RecentKind, type RecentPage } from "@/lib/recent-pages";

function readRecent(slug: string): RecentPage[] {
  try {
    return parseRecentPages(localStorage.getItem(recentKey(slug)));
  } catch {
    return [];
  }
}

/**
 * 최근 본 문서 팝오버. 목록이 일반 문서 트리의 레이아웃 흐름을 차지하지 않아
 * 방문 순서가 바뀌어도 아래 탐색 항목의 위치가 밀리지 않는다.
 */
export function RecentPopover({
  slug,
  current,
  heading,
  emptyText,
  kindLabel,
}: {
  slug: string;
  current: string | undefined;
  heading: string;
  emptyText: string;
  kindLabel: Record<RecentKind, string>;
}) {
  const [items, setItems] = useState<RecentPage[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const load = () => setItems(readRecent(slug));
    load();
    window.addEventListener("jimi:recent", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("jimi:recent", load);
      window.removeEventListener("storage", load);
    };
  }, [slug]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-stone-600 hover:border-stone-300 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <span aria-hidden="true">↺</span>
        {heading}
        {items.length > 0 ? <span className="font-mono text-[10px] text-stone-400">{items.length}</span> : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={heading}
          className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl shadow-stone-900/10"
        >
          <div className="border-b border-stone-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400">
            {heading}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-5 text-sm leading-5 text-stone-400">{emptyText}</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto p-1.5">
              {items.map((item) => {
                const active = item.slug === current;
                return (
                  <li key={item.slug}>
                    <Link
                      href={`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(item.slug)}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={`block rounded-lg px-2.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                        active ? "bg-indigo-50 text-indigo-900" : "text-stone-700 hover:bg-stone-50"
                      }`}
                    >
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="mt-0.5 block text-[11px] text-stone-400">{kindLabel[item.kind]}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
