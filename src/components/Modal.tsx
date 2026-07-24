"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Tooltip } from "@/components/ui/Tooltip";

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
    const panel = panelRef.current;
    const overlay = panel?.parentElement;
    const backgroundNodes = new Set<HTMLElement>();
    let branch: HTMLElement | null | undefined = overlay;
    while (branch?.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) backgroundNodes.add(sibling);
      }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    const background = [...backgroundNodes].map((node) => ({ node, inert: node.inert }));
    for (const item of background) item.node.inert = true;
    const preferred = panel?.querySelector<HTMLElement>("[data-autofocus], [autofocus]");
    const contentControl = panel?.querySelector<HTMLElement>(
      '[data-modal-content] input:not([type="hidden"]):not([disabled]), [data-modal-content] textarea:not([disabled]), [data-modal-content] select:not([disabled]), [data-modal-content] button:not([disabled]), [data-modal-content] a[href]',
    );
    (preferred ?? contentControl ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      // 이 모달 위에 다른 dialog 가 있으면(예: 중첩) 그쪽이 먼저 닫히게 최상단만 처리
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length > 1 && dialogs[dialogs.length - 1] !== panelRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      for (const item of background) item.node.inert = item.inert;
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
        tabIndex={-1}
        className="my-8 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:my-0"
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <div className="flex shrink-0 items-center gap-3">
            <Tooltip label={t("close")}>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("close")}
                className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                ×
              </button>
            </Tooltip>
          </div>
        </div>
        <div data-modal-content className="min-h-0 flex-1 overscroll-contain overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
