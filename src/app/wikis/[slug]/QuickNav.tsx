"use client";
import { createContext, Fragment, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/Modal";
import { quickCaptureAction, movePageAction } from "@/app/wikis/actions";
import { quickNavSearchAction, type QuickNavSearchItem } from "./quick-nav-actions";

type Ctx = {
  openSwitcher: (initialQuery?: string) => void;
  openCapture: (initialBody?: string) => void;
  openMove: (pageSlug: string, currentCategory: string | null, currentVersion: number) => void;
};
const QuickNavCtx = createContext<Ctx | null>(null);
/** 위키 레이아웃 안 어디서든 빠른 이동/캡처/이동 모달을 여는 훅. Provider 밖에서는 null. */
export function useQuickNav() {
  return useContext(QuickNavCtx);
}

/**
 * 빠른 탐색 provider: ⌘P/Ctrl+P 빠른 이동(Quick Switcher, 모든 역할) + ⌘⇧N/Ctrl+Shift+N 빠른 캡처(쓰기 권한).
 * 채팅의 ⌘K/'/'와 e.code 집합이 겹치지 않아 공존한다. 키 핸들러는 capture 단계 + e.code 기준(IME-safe).
 * ⌘N은 브라우저(새 창) 예약이라 쓰지 않고 ⌘⇧N을 쓴다.
 */
export function QuickNavProvider({
  slug,
  canWrite,
  children,
}: {
  slug: string;
  canWrite: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("WikiQuickNav");
  const td = useTranslations("DocumentTypes");
  const tk = useTranslations("Kinds");
  const router = useRouter();
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const requestSeq = useRef(0);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureInitial, setCaptureInitial] = useState(""); // 선택 툴바 등에서 넘어온 프리필 본문
  const [move, setMove] = useState<{ pageSlug: string; category: string; currentVersion: number } | null>(null);

  // 빈 질의는 Page 목록, 입력 중엔 서버 local FTS 결과(Page+Source).
  const [results, setResults] = useState<QuickNavSearchItem[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [requestNonce, setRequestNonce] = useState(0);

  const openSwitcher = useCallback((initialQuery?: string) => {
    setQuery(initialQuery ?? "");
    setSel(0);
    setResults([]);
    setLoading(true);
    setError(false);
    setSwitcherOpen(true);
  }, []);
  const openCapture = useCallback((initialBody?: string) => {
    setCaptureInitial(initialBody ?? "");
    setCaptureOpen(true);
  }, []);
  const openMove = useCallback((pageSlug: string, currentCategory: string | null, currentVersion: number) => {
    setMove({ pageSlug, category: currentCategory ?? "", currentVersion });
  }, []);

  const ctx = useMemo<Ctx>(() => ({ openSwitcher, openCapture, openMove }), [openSwitcher, openCapture, openMove]);

  // 전역 단축키
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && (e.code === "KeyP" || e.key.toLowerCase() === "p")) {
        e.preventDefault();
        openSwitcher();
      } else if (canWrite && mod && e.shiftKey && (e.code === "KeyN" || e.key.toLowerCase() === "n")) {
        e.preventDefault();
        openCapture();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openSwitcher, openCapture, canWrite]);

  // 질의 입력은 debounce, 응답은 sequence로 구버전을 폐기해 느린 응답이 최신 결과를 덮지 않게 한다.
  useEffect(() => {
    if (!switcherOpen) return;
    const seq = ++requestSeq.current;
    let cancelled = false;
    const delay = query.trim() ? 180 : 0;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(false);
      void quickNavSearchAction(slug, query)
        .then((items) => {
          if (cancelled || requestSeq.current !== seq) return;
          setResults(items);
          setSel(0);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled || requestSeq.current !== seq) return;
          setResults([]);
          setError(true);
          setLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, requestNonce, slug, switcherOpen]);

  const go = useCallback(
    (item: QuickNavSearchItem | undefined) => {
      if (!item) return;
      setSwitcherOpen(false);
      const base = `/wikis/${encodeURIComponent(slug)}`;
      router.push(
        item.refType === "source"
          ? `${base}/sources/${encodeURIComponent(item.slug)}`
          : `${base}/${encodeURIComponent(item.slug)}`,
      );
    },
    [router, slug],
  );

  const hrefFor = useCallback(
    (item: QuickNavSearchItem) => {
      const base = `/wikis/${encodeURIComponent(slug)}`;
      return item.refType === "source"
        ? `${base}/sources/${encodeURIComponent(item.slug)}`
        : `${base}/${encodeURIComponent(item.slug)}`;
    },
    [slug],
  );

  const activeId =
    !loading && !error && results.length > 0 && sel >= 0 && sel < results.length
      ? `${listId}-option-${sel}`
      : undefined;
  useEffect(() => {
    if (!switcherOpen || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, switcherOpen]);
  const statusText = loading
    ? t("switcherLoading")
    : error
      ? t("switcherError")
      : t("switcherResultCount", { count: results.length });

  return (
    <QuickNavCtx.Provider value={ctx}>
      {children}

      {/* ⌘P 빠른 이동 */}
      <Modal open={switcherOpen} onClose={() => setSwitcherOpen(false)} title={t("switcherTitle")}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label htmlFor={inputId} className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
            <span aria-hidden="true">⌂</span>
            {t("localSearchLabel")}
          </label>
          {!loading && !error && (
            <span className="text-[11px] tabular-nums text-stone-400">{t("switcherResultCount", { count: results.length })}</span>
          )}
        </div>
        <input
          data-autofocus
          id={inputId}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!loading && !error && results.length > 0}
          aria-controls={!loading && !error && results.length > 0 ? listId : undefined}
          aria-activedescendant={activeId}
          aria-describedby={statusId}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
            setLoading(true);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (results.length > 0) setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (!loading && !error) go(results[sel]);
            }
          }}
          aria-label={t("switcherPlaceholder")}
          placeholder={t("switcherPlaceholder")}
          className="field-control text-sm"
        />
        <span id={statusId} role="status" aria-live="polite" className="sr-only">
          {statusText}
        </span>

        {loading ? (
          <div className="flex items-center gap-2 px-2 py-5 text-sm text-stone-500">
            <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-stone-300 border-t-indigo-600 motion-reduce:animate-none" />
            {t("switcherLoading")}
          </div>
        ) : error ? (
          <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
            <p>{t("switcherError")}</p>
            <button
              type="button"
              onClick={() => setRequestNonce((value) => value + 1)}
              className="btn-danger btn-compact mt-2"
            >
              {t("switcherRetry")}
            </button>
          </div>
        ) : results.length === 0 ? (
          <p className="px-2 py-5 text-sm text-stone-400">{t("switcherEmpty")}</p>
        ) : (
          <ul id={listId} role="listbox" className="mt-2 max-h-80 space-y-0.5 overflow-y-auto overscroll-contain">
            {results.map((item, i) => {
              const kindLabel = item.documentType === "research"
                ? td("research")
                : item.refType === "source"
                  ? t("sourceResult")
                  : tk.has(item.kind) ? tk(item.kind) : t("pageResult");
              const showGroup = Boolean(query.trim() && item.group && results[i - 1]?.group !== item.group);
              return (
                <Fragment key={item.key}>
                  {showGroup && (
                    <li role="presentation" className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                      {item.group === "protected"
                        ? t("protectedGroup")
                        : item.group === "knowledge"
                          ? t("knowledgeGroup")
                          : t("documentsGroup")}
                    </li>
                  )}
                  <li role="none">
                    <Link
                      id={`${listId}-option-${i}`}
                      href={hrefFor(item)}
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => setSwitcherOpen(false)}
                      className={`w-full rounded-md px-2 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                        i === sel ? "bg-stone-200 text-stone-900" : "text-stone-600 hover:bg-stone-100"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-stone-400">{kindLabel}</span>
                      </span>
                      {item.heading && <span className="mt-0.5 block truncate text-xs text-stone-500">{item.heading}</span>}
                      {item.snippet && <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-stone-400">{item.snippet}</span>}
                    </Link>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        )}
        <div className="mt-2 text-[11px] text-stone-400">{t("switcherHint")}</div>
      </Modal>

      {/* ⌘⇧N 빠른 캡처 */}
      {canWrite && (
        <Modal open={captureOpen} onClose={() => setCaptureOpen(false)} title={t("captureTitle")}>
          <form action={quickCaptureAction}>
            <input type="hidden" name="wikiSlug" value={slug} />
            <textarea
              name="body"
              aria-label={t("captureTitle")}
              autoFocus
              defaultValue={captureInitial}
              rows={8}
              placeholder={t("capturePlaceholder")}
              className="field-control text-sm"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-stone-400">{t("captureHint")}</span>
              <button type="submit" className="btn-primary text-sm">
                {t("captureSave")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* 폴더로 이동(refile) */}
      {canWrite && move && (
        <Modal open onClose={() => setMove(null)} title={t("moveTitle")}>
          <form action={movePageAction} onSubmit={() => setMove(null)}>
            <input type="hidden" name="wikiSlug" value={slug} />
            <input type="hidden" name="pageSlug" value={move.pageSlug} />
            <input type="hidden" name="expectedVersion" value={move.currentVersion} />
            <label htmlFor="quick-nav-move-category" className="mb-1 block text-sm text-stone-600">{t("moveLabel")}</label>
            <input
              id="quick-nav-move-category"
              name="category"
              defaultValue={move.category}
              placeholder={t("movePlaceholder")}
              className="field-control text-sm"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-stone-400">{t("moveToInboxHint")}</span>
              <button type="submit" className="btn-primary text-sm">
                {t("moveSubmit")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </QuickNavCtx.Provider>
  );
}
