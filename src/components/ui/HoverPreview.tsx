"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { computeFloatingPosition } from "@/lib/floating";
import { pagePreviewAction, type PagePreview } from "@/app/wikis/[slug]/preview-actions";

const SHOW_DELAY = 400; // hover 의도 감지
const HIDE_LINGER = 150; // 앵커 → 카드로 포인터를 옮길 여유
const CACHE_MAX = 100;

type Ctx = {
  show: (anchor: HTMLElement, pageSlug: string) => void;
  hide: () => void;
};
const HoverPreviewCtx = createContext<Ctx | null>(null);
/** 위키 레이아웃 안에서 내부 링크 미리보기를 붙이는 훅. Provider 밖(공개 뷰 등)에서는 null → 무동작. */
export function useHoverPreview() {
  return useContext(HoverPreviewCtx);
}

/**
 * 내부 링크 hover 미리보기 카드. 400ms hover 의도 후 서버 액션으로 발췌를 가져와
 * 앵커 근처(fixed, 플립·클램프)에 카드를 띄운다. 카드 자체도 hover 가능(150ms 유예).
 * 터치 기기는 무동작. 응답은 세션 캐시(Map, 100개 상한) + 시퀀스 가드로 구버전을 폐기.
 * 포털은 표시 시점에만 마운트 — 모달 inert 스냅샷에 걸리지 않는다.
 */
export function HoverPreviewProvider({ wikiSlug, children }: { wikiSlug: string; children: React.ReactNode }) {
  const t = useTranslations("HoverPreview");
  const tk = useTranslations("Kinds");
  const td = useTranslations("DocumentTypes");
  const locale = useLocale();

  const [view, setView] = useState<{ slug: string; data: PagePreview } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const pendingAnchor = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const requestSeq = useRef(0);
  const cache = useRef(new Map<string, PagePreview | null>());

  const close = useCallback(() => {
    requestSeq.current += 1; // 비행 중 응답 폐기
    pendingAnchor.current = null;
    setView(null);
  }, []);

  const clearTimers = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  const open = useCallback(
    (anchor: HTMLElement, pageSlug: string) => {
      anchorRef.current = anchor;
      const seq = ++requestSeq.current;
      const cached = cache.current.get(pageSlug);
      if (cached !== undefined) {
        if (cached) setView({ slug: pageSlug, data: cached });
        return;
      }
      void pagePreviewAction(wikiSlug, pageSlug)
        .then((data) => {
          if (requestSeq.current !== seq) return;
          if (cache.current.size >= CACHE_MAX) {
            const oldest = cache.current.keys().next().value;
            if (oldest !== undefined) cache.current.delete(oldest);
          }
          cache.current.set(pageSlug, data);
          if (data) setView({ slug: pageSlug, data });
        })
        .catch(() => {
          /* 미리보기는 보조 UI — 실패는 조용히 무시 */
        });
    },
    [wikiSlug],
  );

  const show = useCallback(
    (anchor: HTMLElement, pageSlug: string) => {
      if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      // 같은 앵커 안에서의 mouseover 반복은 의도 타이머를 리셋하지 않는다.
      if (pendingAnchor.current === anchor || anchorRef.current === anchor) return;
      pendingAnchor.current = anchor;
      if (showTimer.current !== null) window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => {
        showTimer.current = null;
        if (pendingAnchor.current === anchor) open(anchor, pageSlug);
      }, SHOW_DELAY);
    },
    [open],
  );

  const hide = useCallback(() => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    pendingAnchor.current = null;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      anchorRef.current = null;
      close();
    }, HIDE_LINGER);
  }, [close]);

  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, []);

  // 카드 실측 후 위치를 DOM에 직접 반영(그때까지 visibility:hidden). 본문 링크라 아래(bottom) 선호.
  useEffect(() => {
    if (!view) return;
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const pos = computeFloatingPosition(a, { width: c.width, height: c.height }, {
      placement: "bottom",
      offset: 8,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    card.style.top = `${pos.top}px`;
    card.style.left = `${pos.left}px`;
    card.style.visibility = "visible";
  }, [view]);

  // 열림 동안: scroll/Escape/외부 pointerdown/포커스 이탈(모달 오픈 포함) 시 닫기
  useEffect(() => {
    if (!view) return;
    const onScroll = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target)) return;
      close();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [view, close]);

  const ctx = useMemo<Ctx>(() => ({ show, hide }), [show, hide]);

  const data = view?.data;
  const kindLabel = data
    ? data.documentType === "research"
      ? td("research")
      : tk.has(data.kind)
        ? tk(data.kind)
        : data.kind
    : "";
  const updatedLabel = data
    ? t("updated", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(data.updatedAt)) })
    : "";

  return (
    <HoverPreviewCtx.Provider value={ctx}>
      {children}
      {data &&
        createPortal(
          <div
            ref={cardRef}
            role="tooltip"
            onMouseEnter={cancelHide}
            onMouseLeave={hide}
            style={{ top: 0, left: 0, visibility: "hidden" }}
            className="card fixed z-[80] w-80 p-3 shadow-lg"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-stone-800">{data.title}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-stone-400">{kindLabel}</span>
            </div>
            {data.category && <div className="mt-0.5 truncate text-[11px] text-stone-400">{data.category}</div>}
            {data.excerpt && <p className="mt-2 line-clamp-4 text-xs leading-5 text-stone-600">{data.excerpt}</p>}
            <div className="mt-2 text-[11px] text-stone-400">{updatedLabel}</div>
          </div>,
          document.body,
        )}
    </HoverPreviewCtx.Provider>
  );
}
