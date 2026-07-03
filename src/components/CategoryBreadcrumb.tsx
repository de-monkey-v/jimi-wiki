import Link from "next/link";

/**
 * 페이지의 카테고리 경로를 브레드크럼으로 표시. 폴더(사이드바)는 자기 세그먼트만,
 * 페이지는 여기서 전체 경로(ai / models / generative)를 보유·표시한다.
 * linked=true(비공개): 각 세그먼트 → 그 카테고리(및 하위) 페이지 목록 라우트.
 * linked=false(공개): 라우트가 비공개라 정적 텍스트.
 */
export function CategoryBreadcrumb({
  wikiSlug,
  category,
  linked = true,
}: {
  wikiSlug: string;
  category: string;
  linked?: boolean;
}) {
  const segs = category.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-stone-400">
      {segs.map((seg, i) => {
        const prefix = segs.slice(0, i + 1).join("/");
        const isLast = i === segs.length - 1;
        return (
          <span key={prefix} className="flex items-center gap-1">
            {i > 0 && <span className="text-stone-300">/</span>}
            {linked ? (
              <Link
                href={`/wikis/${encodeURIComponent(wikiSlug)}/category/${prefix.split("/").map(encodeURIComponent).join("/")}`}
                className={isLast ? "font-medium text-stone-500 hover:underline" : "hover:underline"}
              >
                {seg}
              </Link>
            ) : (
              <span className={isLast ? "font-medium text-stone-500" : ""}>{seg}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
