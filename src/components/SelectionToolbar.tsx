"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { computeFloatingPosition } from "@/lib/floating";
import { useQuickNav } from "@/app/wikis/[slug]/QuickNav";

const DEBOUNCE = 150;
const SEARCH_QUERY_MAX = 80;

/**
 * 본문 텍스트 드래그 선택 시 선택 영역 위에 뜨는 액션 툴바(복사·인용 복사·위키 검색·캡처).
 * 데스크톱 전용 — 터치 기기는 네이티브 선택 메뉴가 우선이라 무동작. 선택이 containerRef 내부일 때만
 * 반응하고, 스크롤/Escape/선택 해제/외부 클릭 시 숨는다. 포털은 표시 시점에만 마운트(inert-safe).
 */
export function SelectionToolbar({
  containerRef,
  pageSlug,
  canWrite,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  pageSlug: string;
  canWrite: boolean;
}) {
  const t = useTranslations("SelectionToolbar");
  const quick = useQuickNav();
  const [sel, setSel] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [copied, setCopied] = useState<"copy" | "quote" | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const debounceTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const lastText = useRef<string | null>(null);

  const evaluate = useCallback(() => {
    const selection = document.getSelection();
    const container = containerRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) {
      setSel(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setSel(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setSel(null);
      return;
    }
    setSel({ text, rect: range.getBoundingClientRect() });
    // 같은 선택의 재평가(버튼 클릭 mouseup 등)에서는 "복사됨" 플래시를 유지한다
    if (lastText.current !== text) setCopied(null);
    lastText.current = text;
  }, [containerRef]);

  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const onSelectionChange = () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => {
        debounceTimer.current = null;
        evaluate();
      }, DEBOUNCE);
    };
    const onMouseUp = () => {
      // mouseup 직후에는 지연 없이 바로 평가(드래그를 끝낸 순간 툴바가 떠야 자연스럽다)
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => {
        debounceTimer.current = null;
        evaluate();
      }, 0);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mouseup", onMouseUp);
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [evaluate]);

  // 실측 후 위치를 DOM에 직접 반영 — 선택 영역 위(top) 선호, 뷰포트 상단 근처면 아래로 플립.
  useEffect(() => {
    if (!sel) return;
    const bar = barRef.current;
    if (!bar) return;
    const size = bar.getBoundingClientRect();
    const pos = computeFloatingPosition(sel.rect, { width: size.width, height: size.height }, {
      placement: "top",
      offset: 8,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    bar.style.top = `${pos.top}px`;
    bar.style.left = `${pos.left}px`;
    bar.style.visibility = "visible";
  }, [sel]);

  useEffect(() => {
    if (!sel) return;
    const onScroll = () => setSel(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [sel]);

  const flashCopied = (kind: "copy" | "quote") => {
    setCopied(kind);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopied(null);
    }, 1200);
  };

  if (!sel) return null;

  const quote = `${sel.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n> — [[${pageSlug}]]`;

  const buttonCls =
    "rounded px-2 py-1 text-xs font-medium text-stone-200 hover:bg-stone-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t("toolbarLabel")}
      // mousedown 기본동작(선택 해제·포커스 이동)을 막아 클릭 전에 툴바가 사라지지 않게 한다
      onMouseDown={(e) => e.preventDefault()}
      style={{ top: 0, left: 0, visibility: "hidden" }}
      className="fixed z-[80] flex items-center gap-0.5 rounded-lg bg-stone-900 p-1 shadow-lg"
    >
      <button
        type="button"
        className={buttonCls}
        onClick={() => {
          void navigator.clipboard.writeText(sel.text).then(() => flashCopied("copy"));
        }}
      >
        {copied === "copy" ? t("copied") : t("copy")}
      </button>
      <button
        type="button"
        className={buttonCls}
        onClick={() => {
          void navigator.clipboard.writeText(quote).then(() => flashCopied("quote"));
        }}
      >
        {copied === "quote" ? t("copied") : t("copyQuote")}
      </button>
      {quick && (
        <button
          type="button"
          className={buttonCls}
          onClick={() => {
            const query = sel.text.replace(/\s+/g, " ").slice(0, SEARCH_QUERY_MAX);
            setSel(null);
            quick.openSwitcher(query);
          }}
        >
          {t("searchInWiki")}
        </button>
      )}
      {quick && canWrite && (
        <button
          type="button"
          className={buttonCls}
          onClick={() => {
            setSel(null);
            quick.openCapture(`${quote}\n\n`);
          }}
        >
          {t("capture")}
        </button>
      )}
    </div>,
    document.body,
  );
}
