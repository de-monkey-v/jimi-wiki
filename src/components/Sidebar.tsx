"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { logoutAction } from "@/app/login/actions";

type Wiki = { slug: string; title: string; myRole?: string };

function itemCls(active: boolean) {
  return `block truncate rounded-lg px-3 py-1.5 text-sm ${
    active ? "bg-gray-200 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-100"
  }`;
}

export function Sidebar({ email, owned, shared, showLogout = true }: { email: string; owned: Wiki[]; shared: Wiki[]; showLogout?: boolean }) {
  const t = useTranslations("Sidebar");
  const pathname = decodeURIComponent(usePathname());
  const seg = pathname.split("/"); // ["", "wikis", "<slug>", ...]
  const activeSlug = seg[1] === "wikis" ? seg[2] : undefined;
  const sub = seg[3]; // chat | settings | lint | <pageSlug> | undefined

  const wikiLink = (w: Wiki) => {
    const active = activeSlug === w.slug;
    return (
      <li key={w.slug}>
        <Link href={`/wikis/${w.slug}`} className={itemCls(active && !sub)}>
          {w.title}
          {w.myRole && w.myRole !== "owner" ? (
            <span className="ml-1 text-xs text-gray-400">· {w.myRole === "editor" ? t("role.editor") : t("role.viewer")}</span>
          ) : null}
        </Link>
        {active && (
          <ul className="ml-3 mt-0.5 space-y-0.5 border-l pl-2">
            <li><Link href={`/wikis/${w.slug}/chat`} className={itemCls(sub === "chat")}>{t("chat")}</Link></li>
            <li><Link href={`/wikis/${w.slug}/lint`} className={itemCls(sub === "lint")}>{t("lint")}</Link></li>
            <li><Link href={`/wikis/${w.slug}/settings`} className={itemCls(sub === "settings")}>{t("settings")}</Link></li>
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside className="flex h-dvh w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="px-4 py-4">
        <Link href="/wikis" className="text-lg font-bold tracking-tight">jimi-wiki</Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4 space-y-4">
        <div>
          <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{t("myWikis")}</div>
          <ul className="space-y-0.5">
            {owned.length === 0 && <li className="px-3 py-1 text-sm text-gray-400">{t("empty")}</li>}
            {owned.map(wikiLink)}
          </ul>
        </div>

        {shared.length > 0 && (
          <div>
            <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{t("sharedWikis")}</div>
            <ul className="space-y-0.5">{shared.map(wikiLink)}</ul>
          </div>
        )}

        <div className="border-t pt-3">
          <ul className="space-y-0.5">
            <li><Link href="/wikis" className={itemCls(pathname === "/wikis")}>{t("newWiki")}</Link></li>
            <li><Link href="/keys" className={itemCls(pathname.startsWith("/keys"))}>{t("apiKeys")}</Link></li>
          </ul>
        </div>
      </nav>

      <div className="border-t border-gray-200 px-3 py-3">
        <div className="mb-1 truncate px-1 text-xs text-gray-500">{email}</div>
        {showLogout ? (
          <form action={logoutAction}>
            <button className="w-full rounded-lg px-3 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{t("logout")}</button>
          </form>
        ) : null}
      </div>
    </aside>
  );
}
