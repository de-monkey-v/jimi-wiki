"use client";
import { useEffect } from "react";
import { addRecentPage, parseRecentPages, recentKey, type RecentKind } from "@/lib/recent-pages";

/** 페이지 뷰에 마운트되어 최근 본 문서 목록(기기 로컬)에 기록. 서버 write-on-GET 없음. null 렌더. */
export function RecordVisit({
  wikiSlug,
  pageSlug,
  title,
  kind,
}: {
  wikiSlug: string;
  pageSlug: string;
  title: string;
  kind: RecentKind;
}) {
  useEffect(() => {
    try {
      const raw = localStorage.getItem(recentKey(wikiSlug));
      const next = addRecentPage(parseRecentPages(raw), { slug: pageSlug, title, kind });
      localStorage.setItem(recentKey(wikiSlug), JSON.stringify(next));
      window.dispatchEvent(new Event("jimi:recent"));
    } catch {
      /* localStorage 불가(프라이빗 모드 등) → 무시 */
    }
  }, [wikiSlug, pageSlug, title, kind]);
  return null;
}
