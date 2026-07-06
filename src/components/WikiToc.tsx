"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { logoutAction } from "@/app/login/actions";
import { useChatModal, useShortcutLabel } from "@/app/wikis/[slug]/chat/ChatModal";
import type { TocSection, TocEntry } from "@/lib/kinds";

const RESERVED = new Set(["chat", "lint", "settings", "sources", "graph", "new"]);

function linkCls(active: boolean) {
  return `block truncate rounded-md py-1 pr-2 text-sm ${
    active ? "bg-stone-200 text-stone-900 font-medium" : "text-stone-600 hover:bg-stone-100"
  }`;
}

function entryHasSlug(e: TocEntry, slug: string | undefined): boolean {
  if (!slug) return false;
  if (e.type === "page") return e.slug === slug;
  return e.children.some((c) => entryHasSlug(c, slug));
}
function leafCount(e: TocEntry): number {
  return e.type === "page" ? 1 : e.children.reduce((n, c) => n + leafCount(c), 0);
}

// 페이지 리프와 폴더를 컴포넌트로 분리 — 훅이 early return 뒤에 오면(rules-of-hooks 위반)
// hydration이 통째로 죽어 사이드바 전체가 클릭 불능이 된다.
function EntryNode({
  entry,
  slug,
  current,
  depth,
}: {
  entry: TocEntry;
  slug: string;
  current: string | undefined;
  depth: number;
}) {
  if (entry.type === "page") {
    return (
      <li>
        <Link
          href={`/wikis/${slug}/${entry.slug}`}
          className={linkCls(entry.slug === current)}
          style={{ paddingLeft: depth * 12 + 20 }}
        >
          {entry.title}
        </Link>
      </li>
    );
  }
  return <FolderNode entry={entry} slug={slug} current={current} depth={depth} />;
}

function FolderNode({
  entry,
  slug,
  current,
  depth,
}: {
  entry: Extract<TocEntry, { type: "folder" }>;
  slug: string;
  current: string | undefined;
  depth: number;
}) {
  const active = entryHasSlug(entry, current);
  // 기본: 활성 조상/최상위 폴더는 펼침. 수동 토글은 active가 바뀌기 전까지만 유효 —
  // 네비게이션으로 다시 활성화되면 자동 펼침이 복원된다(effect 없이 파생 상태로).
  const [override, setOverride] = useState<{ open: boolean; whenActive: boolean } | null>(null);
  const open = override && override.whenActive === active ? override.open : active || depth < 1;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOverride({ open: !open, whenActive: active })}
        className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-sm text-stone-500 hover:bg-stone-100"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <span className="w-3 shrink-0 text-xs text-stone-400">{open ? "▾" : "▸"}</span>
        <span className="flex-1 truncate text-left">{entry.name}</span>
        <span className="text-xs text-stone-300">{leafCount(entry)}</span>
      </button>
      {open && (
        <ul className="mt-0.5 space-y-0.5">
          {entry.children.map((c) => (
            <EntryNode
              key={c.type === "folder" ? `f:${c.path}` : `p:${c.slug}`}
              entry={c}
              slug={slug}
              current={current}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function WikiToc({
  slug,
  title,
  email,
  role,
  sections,
}: {
  slug: string;
  title: string;
  email: string;
  role: "viewer" | "editor" | "owner";
  sections: TocSection[];
}) {
  const pathname = decodeURIComponent(usePathname());
  const seg = pathname.split("/"); // ["", "wikis", "<slug>", "<sub>", ...]
  const sub = seg[3];
  const current = sub && !RESERVED.has(sub) ? sub : undefined;
  const chatModal = useChatModal();
  const shortcut = useShortcutLabel();

  return (
    <aside className="flex h-dvh w-72 shrink-0 flex-col border-r border-stone-200 bg-white">
      <div className="border-b border-stone-100 px-3 py-3">
        <Link href="/wikis" className="text-xs text-stone-400 hover:text-stone-600">← 내 위키</Link>
        <Link href={`/wikis/${slug}`} className="mt-1 block truncate text-base font-bold tracking-tight">
          {title}
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {sections.length === 0 ? (
          <p className="px-2 py-1 text-sm text-stone-400">아직 페이지가 없습니다.</p>
        ) : (
          <div className="space-y-4">
            {sections.map((s) => (
              <div key={s.key}>
                <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{s.label}</div>
                <ul className="space-y-0.5">
                  {s.entries.map((e) => (
                    <EntryNode
                      key={e.type === "folder" ? `f:${e.path}` : `p:${e.slug}`}
                      entry={e}
                      slug={slug}
                      current={current}
                      depth={0}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </nav>

      <div className="border-t border-stone-100 px-2 py-2">
        <ul className="space-y-0.5">
          <li>
            {/* 링크 폴백: hydration 전엔 /chat 페이지로 이동, 후엔 클릭을 가로채 모달 오픈 */}
            <Link
              href={`/wikis/${slug}/chat`}
              onClick={(e) => {
                if (chatModal) {
                  e.preventDefault();
                  chatModal.open();
                }
              }}
              className={`flex w-full items-center px-2 ${linkCls(sub === "chat")}`}
            >
              <span className="flex-1">AI에게 질문</span>
              <kbd className="rounded border border-stone-200 bg-stone-50 px-1 text-[10px] text-stone-400">{shortcut} · /</kbd>
            </Link>
          </li>
          {role !== "viewer" && (
            <li>
              <Link href={`/wikis/${slug}/new`} className={`px-2 ${linkCls(sub === "new")}`}>+ 새 페이지</Link>
            </li>
          )}
          <li>
            <Link href={`/wikis/${slug}/graph`} className={`px-2 ${linkCls(sub === "graph")}`}>그래프</Link>
          </li>
          {role !== "viewer" && (
            <li>
              <Link href={`/wikis/${slug}/lint`} className={`px-2 ${linkCls(sub === "lint")}`}>건강검진</Link>
            </li>
          )}
          <li>
            {/* 전역 /docs 라우트로 나가는 링크 — 위키 셸 밖이라 sub 하이라이트 대상 아님 */}
            <Link href={`/docs?wiki=${encodeURIComponent(slug)}`} className={`px-2 ${linkCls(false)}`}>연동 가이드</Link>
          </li>
          {role === "owner" && (
            <li>
              <Link href={`/wikis/${slug}/settings`} className={`px-2 ${linkCls(sub === "settings")}`}>설정</Link>
            </li>
          )}
        </ul>
      </div>

      <div className="border-t border-stone-200 px-3 py-2">
        <div className="mb-1 truncate px-1 text-xs text-stone-500">{email}</div>
        <form action={logoutAction}>
          <button className="w-full rounded-md px-2 py-1 text-left text-sm text-stone-600 hover:bg-stone-100">로그아웃</button>
        </form>
      </div>
    </aside>
  );
}
