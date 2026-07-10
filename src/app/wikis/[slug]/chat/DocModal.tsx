"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import GithubSlugger from "github-slugger";
import { fetchEvidenceDoc } from "./actions";

export type EvidenceDoc = { kind: "page" | "source"; slug: string; title: string; heading?: string };

type DocContent = {
  title: string;
  html: string;
  url: string | null;
  empty: boolean;
  related: { slug: string; title: string }[];
};

// 세션 내 문서 캐시: 재오픈·뒤로가기 시 서버 왕복 없이 즉시 렌더
const docCache = new Map<string, DocContent>();
const cacheKey = (wikiSlug: string, d: { kind: string; slug: string }) => `${wikiSlug}:${d.kind}:${d.slug}`;

/**
 * 근거 문서 모달 v2: 전체 문서 렌더 + 인용 섹션 앵커 스크롤 + 모달 내 위키링크 이어보기(뒤로가기 스택)
 * + 접근성(portal, 포커스 트랩/복귀, aria-labelledby) + 캐시.
 */
export function DocModal({ doc, wikiSlug, onClose }: { doc: EvidenceDoc | null; wikiSlug: string; onClose: () => void }) {
  const t = useTranslations("WikisSlugChatDocModal");
  // 이어보기 스택: prop doc이 바뀌면 [doc]으로 리셋
  const rootKey = doc ? `${doc.kind}:${doc.slug}:${doc.heading ?? ""}` : "";
  const [nav, setNav] = useState<{ rootKey: string; stack: EvidenceDoc[] }>({ rootKey: "", stack: [] });
  const stack = useMemo(() => (doc && nav.rootKey === rootKey ? nav.stack : doc ? [doc] : []), [doc, nav, rootKey]);
  const current = stack.length > 0 ? stack[stack.length - 1] : null;

  const [state, setState] = useState<{ loading: boolean; data?: DocContent; error?: boolean }>({ loading: false });
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // 문서 로드(캐시 우선)
  const load = useCallback(() => {
    if (!current) return;
    const k = cacheKey(wikiSlug, current);
    const cached = docCache.get(k);
    if (cached) {
      setState({ loading: false, data: cached });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    fetchEvidenceDoc(wikiSlug, current.kind, current.slug)
      .then((r) => {
        if (cancelled) return;
        if (r) {
          docCache.set(k, r);
          setState({ loading: false, data: r });
        } else {
          setState({ loading: false, error: true });
        }
      })
      .catch(() => !cancelled && setState({ loading: false, error: true }));
    return () => {
      cancelled = true;
    };
  }, [wikiSlug, current]);
  useEffect(() => load(), [load]);

  // 인용 섹션 앵커: 렌더 후 heading id로 스크롤 + 임시 하이라이트 (미스매치는 조용히 폴백)
  useEffect(() => {
    if (!state.data || !current?.heading || !bodyRef.current) return;
    const id = new GithubSlugger().slug(current.heading);
    const el = bodyRef.current.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("bg-amber-50", "transition-colors", "duration-1000");
    const t = setTimeout(() => el.classList.remove("bg-amber-50"), 2000);
    return () => clearTimeout(t);
  }, [state.data, current]);

  // 접근성: 열릴 때 포커스 이동, Tab 트랩, Escape 닫기, 닫힐 때 포커스 복귀 + body 스크롤 잠금
  useEffect(() => {
    if (!doc) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const f = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!f || f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
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
      prevFocus.current?.focus?.();
    };
  }, [doc, onClose]);

  // 모달 내 위키링크 이어보기: a.wikilink 클릭을 가로채 스택에 push (깨진 링크는 무시)
  const onBodyClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !bodyRef.current?.contains(a)) return;
    if (!a.classList.contains("wikilink")) return; // 외부/일반 링크는 기본 동작
    e.preventDefault();
    if (a.classList.contains("wikilink-missing")) return; // 없는 페이지 — 무반응
    const seg = a.getAttribute("href")?.split("/").pop();
    if (!seg) return;
    const slug = decodeURIComponent(seg);
    setNav({ rootKey, stack: [...stack, { kind: "page", slug, title: a.textContent ?? slug }] });
  }, [rootKey, stack]);

  if (!doc || !current) return null;
  const href =
    current.kind === "source" ? `/wikis/${wikiSlug}/sources/${current.slug}` : `/wikis/${wikiSlug}/${current.slug}`;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {stack.length > 1 && (
              <button
                onClick={() => setNav({ rootKey, stack: stack.slice(0, -1) })}
                className="shrink-0 rounded border border-stone-200 px-1.5 py-0.5 text-xs text-stone-500 hover:bg-stone-50"
              >
                ← {t("back")}
              </button>
            )}
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-stone-400">
                {current.kind === "source" ? t("kind.source") : t("kind.page")}
              </div>
              <h2 id={titleId} className="truncate text-base font-semibold">
                {state.data?.title ?? current.title}
              </h2>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <a href={href} className="text-xs text-blue-600 hover:underline">{t("fullPage")} →</a>
            <button onClick={onClose} aria-label={t("close")} className="text-lg leading-none text-stone-400 hover:text-stone-700">
              ✕
            </button>
          </div>
        </div>
        <div ref={bodyRef} onClick={onBodyClick} className="overflow-y-auto px-6 py-5">
          {state.loading && <p className="text-sm text-stone-400">{t("loading")}</p>}
          {state.error && (
            <p className="text-sm text-red-600">
              {t("loadError")}{" "}
              <button onClick={load} className="underline">{t("retry")}</button>
            </p>
          )}
          {state.data && (
            <>
              {state.data.url && (
                <a
                  href={state.data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mb-3 block truncate text-sm text-blue-600 hover:underline"
                >
                  {state.data.url}
                </a>
              )}
              {state.data.empty ? (
                <p className="text-sm text-stone-400">{t("emptyBody")}</p>
              ) : (
                <article className="wiki-content" dangerouslySetInnerHTML={{ __html: state.data.html }} />
              )}
              {state.data.related.length > 0 && (
                <div className="mt-6 border-t border-stone-200 pt-3">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">{t("relatedDocs")}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {state.data.related.map((r) => (
                      <button
                        key={r.slug}
                        onClick={() => setNav({ rootKey, stack: [...stack, { kind: "page", slug: r.slug, title: r.title }] })}
                        className="rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:border-blue-400 hover:text-blue-700"
                      >
                        {r.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
