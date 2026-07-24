"use client";
import { useListNav } from "@/lib/useListNav";
import { ReadingRow } from "./ReadingRow";

export type ReadingItem = {
  id: string;
  url: string;
  title: string;
  description: string | null;
  summary: string | null;
  savedAt: string;
  promoted: boolean;
};

/** 읽을거리 목록 컨테이너 — ↑/↓/Home/End 키보드 탐색(useListNav) + hover 활성 동기화. */
export function ReadingList({ wikiSlug, canPromote, items }: { wikiSlug: string; canPromote: boolean; items: ReadingItem[] }) {
  const { listRef, onKeyDown, itemProps } = useListNav(items.length);
  return (
    <ul ref={listRef} onKeyDown={onKeyDown} className="mt-4 divide-y divide-stone-100">
      {items.map((l, i) => (
        <ReadingRow
          key={l.id}
          wikiSlug={wikiSlug}
          id={l.id}
          url={l.url}
          title={l.title}
          description={l.description}
          summary={l.summary}
          savedAt={l.savedAt}
          promoted={l.promoted}
          canPromote={canPromote}
          navProps={itemProps(i)}
        />
      ))}
    </ul>
  );
}
