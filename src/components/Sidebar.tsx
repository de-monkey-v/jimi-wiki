"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/login/actions";

type Wiki = { slug: string; title: string; myRole?: string };

function itemCls(active: boolean) {
  return `block truncate rounded-lg px-3 py-1.5 text-sm ${
    active ? "bg-gray-200 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-100"
  }`;
}

export function Sidebar({ email, owned, shared }: { email: string; owned: Wiki[]; shared: Wiki[] }) {
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
            <span className="ml-1 text-xs text-gray-400">· {w.myRole === "editor" ? "편집" : "뷰어"}</span>
          ) : null}
        </Link>
        {active && (
          <ul className="ml-3 mt-0.5 space-y-0.5 border-l pl-2">
            <li><Link href={`/wikis/${w.slug}/chat`} className={itemCls(sub === "chat")}>채팅</Link></li>
            <li><Link href={`/wikis/${w.slug}/lint`} className={itemCls(sub === "lint")}>건강검진</Link></li>
            <li><Link href={`/wikis/${w.slug}/settings`} className={itemCls(sub === "settings")}>설정</Link></li>
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
          <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">내 위키</div>
          <ul className="space-y-0.5">
            {owned.length === 0 && <li className="px-3 py-1 text-sm text-gray-400">없음</li>}
            {owned.map(wikiLink)}
          </ul>
        </div>

        {shared.length > 0 && (
          <div>
            <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">공유받은 위키</div>
            <ul className="space-y-0.5">{shared.map(wikiLink)}</ul>
          </div>
        )}

        <div className="border-t pt-3">
          <ul className="space-y-0.5">
            <li><Link href="/wikis" className={itemCls(pathname === "/wikis")}>+ 새 위키</Link></li>
            <li><Link href="/channels" className={itemCls(pathname.startsWith("/channels"))}>채널 둘러보기</Link></li>
            <li><Link href="/keys" className={itemCls(pathname.startsWith("/keys"))}>API 키</Link></li>
          </ul>
        </div>
      </nav>

      <div className="border-t border-gray-200 px-3 py-3">
        <div className="mb-1 truncate px-1 text-xs text-gray-500">{email}</div>
        <form action={logoutAction}>
          <button className="w-full rounded-lg px-3 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-100">로그아웃</button>
        </form>
      </div>
    </aside>
  );
}
