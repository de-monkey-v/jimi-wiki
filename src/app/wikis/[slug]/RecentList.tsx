"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type Recent = { slug: string; title: string };
const key = (slug: string) => `jimi:recent:${slug}`;

function readRecent(slug: string): Recent[] {
  try {
    const raw = localStorage.getItem(key(slug));
    return raw ? (JSON.parse(raw) as Recent[]) : [];
  } catch {
    return [];
  }
}

/** 최근 본 문서(기기 로컬, localStorage). RecordVisit가 쓰고 'jimi:recent' 이벤트로 갱신. 서버 저장·GET 쓰기 없음. */
export function RecentList({ slug, current, heading }: { slug: string; current: string | undefined; heading: string }) {
  const [items, setItems] = useState<Recent[]>([]);
  useEffect(() => {
    const load = () => setItems(readRecent(slug));
    load();
    window.addEventListener("jimi:recent", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("jimi:recent", load);
      window.removeEventListener("storage", load);
    };
  }, [slug]);

  const shown = items.filter((r) => r.slug !== current).slice(0, 6);
  if (shown.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{heading}</div>
      <ul className="space-y-0.5">
        {shown.map((r) => (
          <li key={r.slug}>
            <Link
              href={`/wikis/${slug}/${r.slug}`}
              className="block truncate rounded-md py-1 pr-2 text-sm text-stone-500 hover:bg-stone-100"
              style={{ paddingLeft: 20 }}
            >
              {r.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
