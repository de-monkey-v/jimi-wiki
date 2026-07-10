"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/Modal";
import { listWikiPagesAction, quickCaptureAction, movePageAction } from "@/app/wikis/actions";

type PageItem = { slug: string; title: string; kind: string };
type Ctx = {
  openSwitcher: () => void;
  openCapture: () => void;
  openMove: (pageSlug: string, currentCategory: string | null) => void;
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
  const router = useRouter();

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [move, setMove] = useState<{ pageSlug: string; category: string } | null>(null);

  // 스위처 데이터(첫 오픈 lazy 로드, 열 때마다 갱신)
  const [pages, setPages] = useState<PageItem[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const openSwitcher = useCallback(() => {
    setQuery("");
    setSel(0);
    setSwitcherOpen(true);
    listWikiPagesAction(slug).then(setPages).catch(() => setPages([]));
  }, [slug]);
  const openCapture = useCallback(() => setCaptureOpen(true), []);
  const openMove = useCallback((pageSlug: string, currentCategory: string | null) => {
    setMove({ pageSlug, category: currentCategory ?? "" });
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
        setCaptureOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openSwitcher, canWrite]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? pages.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) : pages;
    return list.slice(0, 50);
  }, [pages, query]);

  const go = useCallback(
    (p: PageItem | undefined) => {
      if (!p) return;
      setSwitcherOpen(false);
      router.push(`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(p.slug)}`);
    },
    [router, slug],
  );

  return (
    <QuickNavCtx.Provider value={ctx}>
      {children}

      {/* ⌘P 빠른 이동 */}
      <Modal open={switcherOpen} onClose={() => setSwitcherOpen(false)} title={t("switcherTitle")}>
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(filtered[sel]);
            }
          }}
          placeholder={t("switcherPlaceholder")}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
        />
        <ul className="mt-2 max-h-80 space-y-0.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-2 py-3 text-sm text-stone-400">{t("switcherEmpty")}</li>
          ) : (
            filtered.map((p, i) => (
              <li key={p.slug}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => go(p)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                    i === sel ? "bg-stone-200 text-stone-900" : "text-stone-600 hover:bg-stone-100"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  <span className="shrink-0 text-[10px] uppercase text-stone-400">{p.kind}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="mt-2 text-[11px] text-stone-400">{t("switcherHint")}</div>
      </Modal>

      {/* ⌘⇧N 빠른 캡처 */}
      {canWrite && (
        <Modal open={captureOpen} onClose={() => setCaptureOpen(false)} title={t("captureTitle")}>
          <form action={quickCaptureAction}>
            <input type="hidden" name="wikiSlug" value={slug} />
            <textarea
              name="body"
              autoFocus
              rows={8}
              placeholder={t("capturePlaceholder")}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-stone-400">{t("captureHint")}</span>
              <button type="submit" className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700">
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
            <label className="mb-1 block text-sm text-stone-600">{t("moveLabel")}</label>
            <input
              name="category"
              defaultValue={move.category}
              placeholder={t("movePlaceholder")}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-stone-400">{t("moveToInboxHint")}</span>
              <button type="submit" className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700">
                {t("moveSubmit")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </QuickNavCtx.Provider>
  );
}
