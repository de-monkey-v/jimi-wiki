"use client";
import { useListNav } from "@/lib/useListNav";
import { CategoryRow, type CategoryRowProps } from "./CategoryRow";

/** 카테고리 목록 컨테이너 — ↑/↓/Home/End 키보드 탐색(useListNav) + hover 활성 동기화. */
export function CategoryList({ rows }: { rows: CategoryRowProps[] }) {
  const { listRef, onKeyDown, itemProps } = useListNav(rows.length);
  return (
    <ul ref={listRef} onKeyDown={onKeyDown} className="space-y-1">
      {rows.map((row, i) => (
        <CategoryRow key={row.pageSlug} {...row} navProps={itemProps(i)} />
      ))}
    </ul>
  );
}
