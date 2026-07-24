import { PreviewLink } from "@/components/ui/PreviewLink";

/** 백링크/관련 문서 목록. note는 "이 소스에서 파생된 문서", 파생은 "관련 문서"로 라벨만 다름. */
export function BacklinksPanel({
  heading,
  emptyText,
  items,
  hrefFor,
}: {
  heading: string;
  emptyText: string;
  items: { slug: string; title: string }[];
  hrefFor: (slug: string) => string;
}) {
  return (
    <section className="mt-12 border-t border-stone-200 pt-4">
      <h2 className="mb-2 text-sm font-semibold text-stone-500">{heading}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-stone-400">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((b) => (
            <li key={b.slug}>
              <PreviewLink pageSlug={b.slug} href={hrefFor(b.slug)} className="text-sm text-blue-600 hover:underline">
                {b.title}
              </PreviewLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
