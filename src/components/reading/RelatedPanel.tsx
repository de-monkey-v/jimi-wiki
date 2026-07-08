import Link from "next/link";
import { useTranslations } from "next-intl";

type Item = { slug: string; title: string };

function LinkGroup({ label, items, hrefFor }: { label: string; items: Item[]; hrefFor: (slug: string) => string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-400">{label}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((b) => (
          <li key={b.slug}>
            <Link
              href={hrefFor(b.slug)}
              className="inline-block rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-700 hover:border-blue-400 hover:text-blue-700"
            >
              {b.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 관련 문서 패널: 이 문서가 참조하는 문서(아웃링크) + 이 문서를 참조하는 문서(백링크)를 함께 보여준다. */
export function RelatedPanel({
  outlinks,
  backlinks,
  hrefFor,
}: {
  outlinks: Item[];
  backlinks: Item[];
  hrefFor: (slug: string) => string;
}) {
  const t = useTranslations("ReadingRelatedPanel");
  return (
    <section className="mt-12 border-t border-stone-200 pt-4">
      <h2 className="mb-3 text-sm font-semibold text-stone-500">{t("title")}</h2>
      {outlinks.length === 0 && backlinks.length === 0 ? (
        <p className="text-sm text-stone-400">{t("empty")}</p>
      ) : (
        <div className="space-y-3">
          <LinkGroup label={t("outlinks")} items={outlinks} hrefFor={hrefFor} />
          <LinkGroup label={t("backlinks")} items={backlinks} hrefFor={hrefFor} />
        </div>
      )}
    </section>
  );
}
