"use client";
import { cloneElement, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeFloatingPosition, type FloatingPlacement } from "@/lib/floating";

// 인접한 툴팁 사이를 옮겨 다닐 때는 매번 500ms를 기다리지 않도록 전역 그레이스(300ms)를 공유한다.
let lastHiddenAt = 0;
const SHOW_DELAY = 500;
const WARM_GRACE = 300;

type ChildProps = {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
};

/**
 * 스타일드 툴팁. 단일 child에 hover/focus 핸들러를 합성해 붙이고, 표시 시점에만 body 포털을
 * 마운트한다(모달 inert 스냅샷보다 늦게 생겨 inert에 안 걸린다). hover 불가 기기(터치)는 무동작 —
 * child의 aria-label이 그대로 접근성 라벨이다. Escape/scroll/leave 시 즉시 숨김.
 */
export function Tooltip({
  label,
  children,
  placement = "top",
}: {
  label: string;
  children: React.ReactElement<ChildProps>;
  placement?: FloatingPlacement;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  const hide = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen((prev) => {
      if (prev) lastHiddenAt = Date.now();
      return false;
    });
  }, []);

  const show = useCallback((el: HTMLElement) => {
    if (!window.matchMedia("(hover: hover)").matches) return;
    anchorRef.current = el;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const delay = Date.now() - lastHiddenAt < WARM_GRACE ? 0 : SHOW_DELAY;
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }, []);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // 포털이 마운트된 뒤 실측 크기로 위치 계산해 DOM에 직접 반영 — 그때까지 visibility:hidden.
  // (state 왕복 없이 스타일만 만지므로 effect 내 setState 캐스케이드가 없다)
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const pos = computeFloatingPosition(a, { width: t.width, height: t.height }, {
      placement,
      offset: 6,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    tip.style.top = `${pos.top}px`;
    tip.style.left = `${pos.left}px`;
    tip.style.visibility = "visible";
  }, [open, placement, label]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onScroll = () => hide();
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, hide]);

  const childProps = children.props;
  // cloneElement는 child의 ref 값을 읽지 않고 props만 합성한다(요소에 wrapper를 씌우면
  // WikiToc의 absolute 배치가 깨져서 cloneElement가 정답) — refs 규칙 오탐.
  // eslint-disable-next-line react-hooks/refs
  const trigger = cloneElement(children, {
    "aria-describedby": open ? id : childProps["aria-describedby"],
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      show(e.currentTarget);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      show(e.currentTarget);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{ top: 0, left: 0, visibility: "hidden" }}
            className="pointer-events-none fixed z-[80] max-w-xs rounded-md bg-stone-900 px-2 py-1 text-xs text-white shadow-md"
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
