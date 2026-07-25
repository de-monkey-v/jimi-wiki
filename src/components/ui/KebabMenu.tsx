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

/** 메뉴 항목 색조 — focus:bg를 hover와 같은 시각 언어로 둔다. 메뉴가 열릴 때 첫 항목에
 * 프로그래매틱 포커스가 들어오는데, :focus-visible만 스타일하면 브라우저 휴리스틱이
 * 매치되지 않아 마우스로 연 경우 하이라이트가 전혀 보이지 않는다. */
const itemToneCls = {
  default: "text-stone-700 hover:bg-stone-100 focus:bg-stone-100 active:bg-stone-200",
  danger: "text-rose-600 hover:bg-rose-50 focus:bg-rose-50 active:bg-rose-100",
} as const;

/**
 * 세로점(⋮) 케밥 드롭다운. 메뉴는 body 포털 + fixed 배치라 사이드바의 overflow 클리핑에
 * 잘리지 않는다(Tooltip과 같은 실측→위치 반영 방식). 외부 pointerdown·Escape·스크롤 시 닫히고,
 * Escape는 capture에서 소비해 모바일 TOC 드로어의 Escape(드로어 닫기)와 이중 발화하지 않는다.
 *
 * 트리거의 hover·눌림·열림·포커스 반응은 호출처와 무관하게 globals.css의 .kebab-trigger가
 * 보장한다(Tailwind 유틸리티는 @layer 안이라 비레이어 .btn-secondary 트리거에서 밀린다).
 * triggerClassName은 크기·위치·노출 같은 레이아웃만 맡는다.
 */
export function KebabMenu({
  label,
  items,
  triggerClassName,
  busy = false,
}: {
  label: string;
  items: KebabMenuItem[];
  triggerClassName?: string;
  busy?: boolean; // 선택한 액션이 진행 중 — 트리거를 스피너로 바꿔 "눌렀는데 무반응" 구간을 없앤다
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // busy 동안 트리거가 disabled 되면 포커스가 body로 떨어진다. 작업이 끝나 다시 활성화됐을 때
  // 포커스가 아무 데도 없으면(=우리가 흘린 것) 트리거로 되돌려 키보드 위치를 복구한다.
  // true→false 전이에서만 동작해야 한다 — 마운트 시 실행되면 페이지 로드 중 포커스를 훔친다.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (document.activeElement === document.body) triggerRef.current?.focus();
  }, [busy]);

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


  // ↑/↓ 순환 이동 + Home/End(항목이 최대 2~3개라 typeahead 등은 두지 않는다).
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    // 메뉴는 body로 포털되지만 React 합성 이벤트는 DOM이 아니라 React 트리를 타고 올라간다.
    // 막지 않으면 목록의 roving 탐색(useListNav)이 같은 키를 먹고 포커스를 행 링크로 빼앗아,
    // 메뉴가 열린 채 아무 항목도 하이라이트되지 않는 상태가 된다.
    e.stopPropagation();
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown" ? (idx + 1) % buttons.length
      : e.key === "ArrowUp" ? (idx - 1 + buttons.length) % buttons.length
      : e.key === "Home" ? 0
      : buttons.length - 1;
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
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`${
          triggerClassName ?? "flex h-8 w-8 items-center justify-center rounded text-base text-stone-400"
        } kebab-trigger`}
      >
        {busy ? (
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
        ) : (
          <span aria-hidden="true">⋮</span>
        )}
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
                // hover 시 포커스를 옮겨 hover=focus 단일 하이라이트(roving) — ↑/↓ 순환과 자연 결합
                onMouseEnter={(e) => e.currentTarget.focus()}
                className={`block w-full px-3 py-1.5 text-left text-sm transition-colors motion-reduce:transition-none focus:outline-none disabled:opacity-50 ${
                  itemToneCls[item.tone ?? "default"]
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
