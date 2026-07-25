// 플로팅 레이어(툴팁·미리보기·선택 툴바) 공용 위치 계산. DOM 없는 순수 함수라 단독 테스트 가능.
// 선호 방향에 공간이 없으면 앵커 반대편으로 플립하고, 좌우는 뷰포트 안으로 클램프한다.

export type FloatingPlacement = "top" | "bottom";

export type FloatingAlign = "center" | "start" | "end";

export type Rect = { top: number; left: number; width: number; height: number };

export type FloatingPosition = { top: number; left: number; placement: FloatingPlacement };

export function computeFloatingPosition(
  anchor: Rect,
  size: { width: number; height: number },
  {
    placement = "top",
    align = "center",
    offset = 6,
    margin = 8,
    viewport,
  }: {
    placement?: FloatingPlacement;
    align?: FloatingAlign;
    offset?: number;
    margin?: number;
    viewport: { width: number; height: number };
  },
): FloatingPosition {
  const topIfAbove = anchor.top - offset - size.height;
  const topIfBelow = anchor.top + anchor.height + offset;
  const fitsAbove = topIfAbove >= margin;
  const fitsBelow = topIfBelow + size.height <= viewport.height - margin;

  let resolved: FloatingPlacement;
  if (placement === "top") {
    resolved = fitsAbove || !fitsBelow ? "top" : "bottom";
  } else {
    resolved = fitsBelow || !fitsAbove ? "bottom" : "top";
  }
  // 양쪽 다 안 맞으면 남는 공간이 큰 쪽으로.
  if (!fitsAbove && !fitsBelow) {
    const roomAbove = anchor.top;
    const roomBelow = viewport.height - (anchor.top + anchor.height);
    resolved = roomAbove >= roomBelow ? "top" : "bottom";
  }

  const top = resolved === "top" ? Math.max(margin, topIfAbove) : topIfBelow;
  const aligned =
    align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.left + anchor.width - size.width
        : anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.min(Math.max(margin, aligned), Math.max(margin, viewport.width - margin - size.width));
  return { top, left, placement: resolved };
}
