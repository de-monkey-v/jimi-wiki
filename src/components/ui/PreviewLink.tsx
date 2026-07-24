"use client";
import Link from "next/link";
import { useHoverPreview } from "@/components/ui/HoverPreview";

/**
 * 미리보기가 붙는 내부 페이지 링크 — 패널 칩·목록 행처럼 명시적 링크 컴포넌트용.
 * HoverPreviewProvider 밖(공개 뷰 등)에서는 일반 Link와 동일하게 동작한다.
 */
export function PreviewLink({
  pageSlug,
  href,
  className,
  children,
}: {
  pageSlug: string;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const preview = useHoverPreview();
  return (
    <Link
      href={href}
      className={className}
      onMouseEnter={(e) => preview?.show(e.currentTarget, pageSlug)}
      onMouseLeave={() => preview?.hide()}
      onFocus={(e) => preview?.show(e.currentTarget, pageSlug)}
      onBlur={() => preview?.hide()}
    >
      {children}
    </Link>
  );
}
