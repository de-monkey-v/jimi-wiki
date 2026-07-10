"use client";
import { createContext, useCallback, useContext } from "react";
import { useRouter } from "next/navigation";

type NewPagePreset = { category?: string; kind?: string };
type Ctx = { openIngest: () => void; openNewPage: (preset?: NewPagePreset) => void };
const WikiActionsCtx = createContext<Ctx | null>(null);

/** 위키 레이아웃 안 어디서든 ingest·새페이지 route modal을 여는 훅. Provider 밖(또는 viewer)에서는 null. */
export function useWikiActions() {
  return useContext(WikiActionsCtx);
}

/**
 * 모든 진입점을 intercepted route로 모은다. 프리셋은 URL query에 담아
 * 뒤로/앞으로가기와 새로고침에서도 동일한 새 페이지 폼을 복원한다.
 */
export function WikiActionsProvider({
  slug,
  canWrite,
  children,
}: {
  slug: string;
  canWrite: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const base = `/wikis/${encodeURIComponent(slug)}`;

  const openIngest = useCallback(() => router.push(`${base}/ingest`), [base, router]);
  const openNewPage = useCallback((p?: NewPagePreset) => {
    const query = new URLSearchParams();
    if (p?.category) query.set("category", p.category);
    if (p?.kind) query.set("kind", p.kind);
    router.push(`${base}/new${query.size > 0 ? `?${query}` : ""}`);
  }, [base, router]);

  // viewer 는 트리거가 렌더되지 않으니 context 도 null(open* 미노출).
  const ctx = canWrite ? { openIngest, openNewPage } : null;

  return <WikiActionsCtx.Provider value={ctx}>{children}</WikiActionsCtx.Provider>;
}
