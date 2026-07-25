"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeFloatingPosition } from "@/lib/floating";

export type KebabMenuItem = {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
};

/**
 * 세로점(⋮) 케밥 드롭다운. 메뉴는 body 포털 + fixed 배치라 사이드바의 overflow 클리핑에
 * 잘리지 않는다(Tooltip과 같은 실측→위치 반영 방식). 외부 pointerdown·Escape·스크롤 시 닫히고,
 * Escape는 capture에서 소비해 모바일 TOC 드로어의 Escape(드로어 닫기)와 이중 발화하지 않는다.
 */
export function KebabMenu({
  label,
  items,
  triggerClassName,
}: {
  label: string;
  items: KebabMenuItem[];
  triggerClassName?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // 포털 마운트 후 실측 크기로 위치 계산(그때까지 visibility:hidden) + 첫 항목 포커스.
  useEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const pos = computeFloatingPosition(a, { width: m.width, height: m.height }, {
      placement: "bottom",
      align: "end",
      offset: 4,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    menu.style.top = `${pos.top}px`;
    menu.style.left = `${pos.left}px`;
    menu.style.visibility = "visible";
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  if (items.length === 0) return null;

  // ↑/↓ 순환 이동(항목이 최대 2~3개라 typeahead 등은 두지 않는다).
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={
          triggerClassName ??
          "flex h-8 w-8 items-center justify-center rounded text-base text-stone-400 hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        }
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{ top: 0, left: 0, visibility: "hidden" }}
            className="fixed z-[80] min-w-36 rounded-md border border-stone-200 bg-white py-1 shadow-lg"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close(true); // 포커스를 트리거로 되돌린 뒤 실행 — confirm 취소 시에도 위치 유지
                  item.onSelect();
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
                  item.tone === "danger"
                    ? "text-rose-600 hover:bg-rose-50"
                    : "text-stone-700 hover:bg-stone-100"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
