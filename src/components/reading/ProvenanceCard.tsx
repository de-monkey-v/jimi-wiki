import Link from "next/link";

/** 소스 노트의 원문(provenance) 카드. href=내부 원문 뷰어(비공개), url=외부 원본 링크(공개 폴백). */
export function ProvenanceCard({ title, href, url }: { title: string; href?: string; url?: string | null }) {
  return (
    <div className="mb-6 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
      <div className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-stone-400">원문 (Source)</div>
      {href ? (
        <Link href={href} className="text-sm font-medium text-blue-600 hover:underline">{title}</Link>
      ) : url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 hover:underline">
          {title}
        </a>
      ) : (
        <span className="text-sm font-medium text-stone-700">{title}</span>
      )}
      {url && <div className="mt-0.5 truncate text-xs text-stone-400">{url}</div>}
    </div>
  );
}
