import Link from "next/link";
import { listPublicWikis } from "@/lib/wiki";

export const dynamic = "force-dynamic";

/** 채널: 공개(visibility=public) 위키 탐색(인증 불필요). */
export default async function Channels() {
  const wikis = await listPublicWikis();
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold mb-6">채널 — 공개 위키</h1>
      {wikis.length === 0 && <p className="text-gray-500">아직 공개된 위키가 없습니다.</p>}
      <ul className="space-y-2">
        {wikis.map((w) => (
          <li key={w.id} className="border rounded-lg p-4 hover:bg-gray-50">
            <Link href={`/channels/${encodeURIComponent(w.slug)}`} className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{w.title}</div>
                {w.description && <div className="text-sm text-gray-500">{w.description}</div>}
                <div className="text-xs text-gray-400 mt-1">by {w.createdBy.name ?? w.createdBy.email}</div>
              </div>
              <div className="text-xs text-gray-400">{w._count.pages} 페이지</div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
