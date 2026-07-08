import Link from "next/link";
import { useTranslations } from "next-intl";

type NavItem = { slug: string; title: string } | null;

/** 목차 순서 기준 이전/다음 카드. 존재하는 방향만 렌더. */
export function PageNav({
  prev,
  next,
  hrefFor,
}: {
  prev: NavItem;
  next: NavItem;
  hrefFor: (slug: string) => string;
}) {
  const t = useTranslations("PageNav");
  if (!prev && !next) return null;
  return (
    <nav className="mt-10 flex items-stretch justify-between gap-3">
      {prev ? (
        <Link
          href={hrefFor(prev.slug)}
          className="flex-1 rounded-lg border border-stone-200 px-4 py-3 hover:bg-stone-50"
        >
          <div className="text-xs text-stone-400">{t("prev")}</div>
          <div className="truncate text-sm font-medium text-stone-800">{prev.title}</div>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link
          href={hrefFor(next.slug)}
          className="flex-1 rounded-lg border border-stone-200 px-4 py-3 text-right hover:bg-stone-50"
        >
          <div className="text-xs text-stone-400">{t("next")}</div>
          <div className="truncate text-sm font-medium text-stone-800">{next.title}</div>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </nav>
  );
}
