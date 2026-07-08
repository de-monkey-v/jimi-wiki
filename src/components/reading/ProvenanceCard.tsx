import Link from "next/link";

/**
 * 소스 노트의 원문(provenance) 카드.
 * - href: 내부 원문 뷰어(앱이 추출·보관한 본문). 비공개 뷰에서만 존재.
 * - url : 외부 원본 페이지. 공개 뷰에선 이것만(내부 원문 라우트 없음).
 * 둘을 명확히 구분해 라벨링한다 — "저장된 원문"(우리가 보관한 감사본) vs "원본 사이트"(외부).
 */
export function ProvenanceCard({ title, href, url }: { title: string; href?: string; url?: string | null }) {
  return (
    <div className="mb-6 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
      <div className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-stone-400">원문 (Source)</div>
      <div className="text-sm font-medium text-stone-700">{title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {href && (
          <Link href={href} className="font-medium text-blue-600 hover:underline">
            📄 저장된 원문 보기
          </Link>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-500 hover:text-stone-700 hover:underline"
            title={url}
          >
            🔗 원본 사이트 ↗
          </a>
        )}
      </div>
    </div>
  );
}
