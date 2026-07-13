"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Intercepted route용 대형 모달. 닫기는 history를 복원하고, 전체 페이지 열기는
 * interception을 다시 타지 않도록 일반 앵커로 hard navigation 한다.
 */
export function RouteModal({
  title,
  fullPageHref,
  children,
}: {
  title: string;
  fullPageHref: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("Modal");
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useCallback(() => router.back(), [router]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
      '[data-route-modal-content] input:not([type="hidden"]):not([disabled]), [data-route-modal-content] textarea:not([disabled]), [data-route-modal-content] select:not([disabled]), [data-route-modal-content] button:not([disabled]), [data-route-modal-content] a[href]',
    );
    (preferred ?? contentControl ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length > 1 && dialogs[dialogs.length - 1] !== panelRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const item of background) item.node.inert = item.inert;
      previousFocus?.focus?.();
    };
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-2 sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex h-[calc(100dvh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-stone-50 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 sm:h-[min(92dvh,900px)]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 sm:px-5">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-stone-700">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-3">
            <a
              href={fullPageHref}
              className="rounded-sm text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t("fullPage")} <span aria-hidden>↗</span>
            </a>
            <button
              type="button"
              onClick={close}
              aria-label={t("close")}
              className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              ×
            </button>
          </div>
        </div>
        <div data-route-modal-content className="min-h-0 flex-1 overscroll-contain overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
