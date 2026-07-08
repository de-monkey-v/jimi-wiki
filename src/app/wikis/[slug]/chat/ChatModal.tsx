"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { WikiChat } from "./WikiChat";

const ChatModalCtx = createContext<{ open: () => void } | null>(null);

/** 위키 레이아웃 안 어디서든 AI 질문 모달을 여는 훅. Provider 밖에서는 null. */
export function useChatModal() {
  return useContext(ChatModalCtx);
}

const noopSubscribe = () => () => {};
/** 플랫폼별 단축키 라벨: Mac은 ⌘K, 그 외(Windows/Linux)는 Ctrl+K. SSR에서는 Ctrl+K. */
export function useShortcutLabel() {
  const isMac = useSyncExternalStore(
    noopSubscribe,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent),
    () => false,
  );
  return isMac ? "⌘K" : "Ctrl+K";
}

/**
 * AI 질문 모달 Provider: 위키 레이아웃에 마운트되어 ⌘K/Ctrl+K 또는 open()으로 모달을 띄운다.
 * 페이지 이동 없이 현재 읽던 문서 위에 오버레이 — 닫아도 언마운트하지 않아 대화가 유지된다.
 */
export function ChatModalProvider({
  slug,
  title,
  children,
}: {
  slug: string;
  title: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("WikisSlugChatChatModal");
  const [isOpen, setIsOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false); // 첫 오픈 후 계속 마운트 → useChat 대화 보존
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const shortcut = useShortcutLabel();
  // /chat 전체 화면에서는 FAB를 숨긴다(채팅 인스턴스 중복 방지)
  const onChatPage = decodeURIComponent(usePathname()).split("/")[3] === "chat";

  const open = useCallback(() => {
    setEverOpened(true);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  // 단축키: ⌘K/Ctrl+K 토글 + "/" 열기(입력 중이 아닐 때).
  // - "/"는 브라우저가 예약하지 않는 키 — Brave처럼 Ctrl+K를 브라우저가 먼저 소비하는 환경의 대체 경로.
  // - e.key 대신 물리 키(e.code) 기준: 한글 IME가 켜져 있으면 e.key가 "ㅏ"로 들어와 단축키를 놓친다.
  // - capture 단계 등록: 에디터 등 하위 핸들러가 stopPropagation으로 전파를 끊어도
  //   브라우저 기본 동작(주소창 검색)보다 먼저 preventDefault를 보장한다.
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const modK = (e.metaKey || e.ctrlKey) && (e.code === "KeyK" || e.key.toLowerCase() === "k");
      const slash =
        (e.key === "/" || e.code === "Slash") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !isTypingTarget(e.target);
      if (modK) {
        e.preventDefault();
        setEverOpened(true);
        setIsOpen((v) => !v);
      } else if (slash) {
        e.preventDefault();
        setEverOpened(true);
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 열림 동안: Escape 닫기(위에 근거 문서 모달이 떠 있으면 그쪽이 우선), 포커스 이동/복귀, body 스크롤 잠금
  useEffect(() => {
    if (!isOpen) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector("textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // DocModal(role=dialog)이 이 모달 위에 열려 있으면 Escape는 그 모달만 닫는다
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length > 1) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.();
    };
  }, [isOpen, close]);

  return (
    <ChatModalCtx.Provider value={{ open }}>
      {children}
      {/* 플로팅 챗봇 버튼: 어디서든 보이는 진입점. 링크 폴백 — JS가 죽어 있어도 /chat 페이지로 이동한다. */}
      {!isOpen && !onChatPage && (
        <Link
          href={`/wikis/${encodeURIComponent(slug)}/chat`}
          onClick={(e) => {
            e.preventDefault();
            open();
          }}
          aria-label={t("askAi")}
          title={t("askAiWithShortcut", { shortcut })}
          className="fixed bottom-6 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-stone-900 text-white shadow-lg transition-transform hover:scale-105 hover:bg-stone-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 1 1 16.1-3.8z" />
          </svg>
        </Link>
      )}
      {everOpened &&
        createPortal(
          <div
            className={isOpen ? "fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" : "hidden"}
            onMouseDown={(e) => e.target === e.currentTarget && close()}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={t("dialogLabel", { title })}
              className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-xl bg-stone-50 shadow-2xl"
            >
              <div className="flex items-center justify-between gap-3 rounded-t-xl border-b border-stone-200 bg-white px-5 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{t("askAi")}</h2>
                  <p className="truncate text-xs text-stone-400">
                    {t("basisDescription", { title })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <kbd className="hidden rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-400 sm:inline">
                    {shortcut} · /
                  </kbd>
                  <Link
                    href={`/wikis/${encodeURIComponent(slug)}/chat`}
                    onClick={close}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    {t("fullScreen")}
                  </Link>
                  <button
                    onClick={close}
                    aria-label={t("close")}
                    className="text-lg leading-none text-stone-400 hover:text-stone-700"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <WikiChat slug={slug} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ChatModalCtx.Provider>
  );
}
