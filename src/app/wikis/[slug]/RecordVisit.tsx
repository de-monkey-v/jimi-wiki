"use client";
import { useEffect } from "react";

const key = (slug: string) => `jimi:recent:${slug}`;

/** 페이지 뷰에 마운트되어 최근 본 문서 목록(기기 로컬)에 기록. 서버 write-on-GET 없음. null 렌더. */
export function RecordVisit({ wikiSlug, pageSlug, title }: { wikiSlug: string; pageSlug: string; title: string }) {
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key(wikiSlug));
      const list = raw ? (JSON.parse(raw) as { slug: string; title: string }[]) : [];
      const next = [{ slug: pageSlug, title }, ...list.filter((r) => r.slug !== pageSlug)].slice(0, 8);
      localStorage.setItem(key(wikiSlug), JSON.stringify(next));
      window.dispatchEvent(new Event("jimi:recent"));
    } catch {
      /* localStorage 불가(프라이빗 모드 등) → 무시 */
    }
  }, [wikiSlug, pageSlug, title]);
  return null;
}
