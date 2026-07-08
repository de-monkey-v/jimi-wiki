import Link from "next/link";
import { useTranslations } from "next-intl";

type SourceRef = { slug: string; title: string; url?: string | null };

/**
 * 파생 페이지(concept/entity)의 "출처(원본)" 카드. 이 지식이 유래한 원본으로 가는 길.
 * 비공개: 원문 뷰어로 링크(hrefFor). 공개: 내부 원문 라우트가 없어 외부 url만(또는 제목 텍스트).
 */
export function SourcesPanel({ sources, hrefFor }: { sources: SourceRef[]; hrefFor?: (slug: string) => string }) {
  const t = useTranslations("ReadingSourcesPanel");
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mb-6 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{t("heading")}</div>
      <ul className="space-y-0.5">
        {sources.map((s) => (
          <li key={s.slug} className="text-sm">
            {hrefFor ? (
              <Link href={hrefFor(s.slug)} className="text-blue-600 hover:underline">
                {s.title}
              </Link>
            ) : s.url ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                {s.title}
              </a>
            ) : (
              <span className="text-stone-600">{s.title}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
