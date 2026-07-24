"use client";
import { useCallback, useRef, useState } from "react";

/**
 * QuickNav의 sel 인덱스 idiom(↑/↓ + mouseEnter 동기화 + nearest 스크롤)을 일반 목록으로 일반화한
 * roving 키보드 탐색. 컨테이너(ul)에 ref+onKeyDown을, 각 행에 itemProps(i)를 붙인다.
 * keydown은 목록 안에 포커스가 있을 때만 도달하므로(버블) 페이지 스크롤을 가로채지 않는다.
 * Enter는 포커스된 링크의 네이티브 동작에 맡긴다. 활성 행 시각화는 data-active 속성으로.
 */
export function useListNav(count: number) {
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement | null>(null);

  const focusItem = useCallback((index: number) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>("[data-listnav-item]");
    const item = items?.[index];
    if (!item) return;
    item.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus();
    item.scrollIntoView({ block: "nearest" });
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (count === 0) return;
      let next: number;
      if (e.key === "ArrowDown") next = Math.min(active + 1, count - 1);
      else if (e.key === "ArrowUp") next = Math.max(active - 1, 0);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = count - 1;
      else return;
      e.preventDefault();
      setActive(next);
      focusItem(next);
    },
    [active, count, focusItem],
  );

  const itemProps = useCallback(
    (index: number) => ({
      "data-listnav-item": "",
      "data-active": index === active ? "" : undefined,
      onMouseEnter: () => setActive(index),
    }),
    [active],
  );

  return { listRef, active, onKeyDown, itemProps };
}
