"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

/**
 * 일반 모달 셸. portal 오버레이 + 바깥 클릭/Escape 닫기 + body 스크롤 잠금 + 첫 입력 포커스/복귀.
 * ChatModal 의 검증된 규약을 일반화한 것(채팅 파일은 건드리지 않는다). open=false 면 언마운트 → 폼이 매 오픈 리셋.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("Modal");
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    // 첫 포커스 가능한 입력으로 이동
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), textarea, select, button",
    );
    focusable?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 이 모달 위에 다른 dialog 가 있으면(예: 중첩) 그쪽이 먼저 닫히게 최상단만 처리
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length > 1 && dialogs[dialogs.length - 1] !== panelRef.current) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overscroll-contain overflow-y-auto bg-black/40 p-4 sm:items-center"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="my-8 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:my-0"
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close")}
              className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              ×
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
