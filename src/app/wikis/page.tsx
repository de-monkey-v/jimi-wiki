import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { listOwnedWikis, listSharedWikis } from "@/lib/wiki";
import { createWikiAction } from "./actions";
import { logoutAction } from "../login/actions";

const ROLE_LABEL: Record<string, string> = { owner: "소유자", editor: "편집자", viewer: "뷰어" };

export default async function WikisPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [owned, shared] = await Promise.all([listOwnedWikis(user.id), listSharedWikis(user.id)]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">jimi-wiki</h1>
        <div className="flex items-center gap-3 text-sm text-stone-500">
          <Link href="/keys" className="hover:text-stone-800">API 키</Link>
          <Link href="/docs" className="hover:text-stone-800">연동 가이드</Link>
          <span className="text-stone-300">·</span>
          <span className="text-xs text-stone-400">{user.email}</span>
          <form action={logoutAction}>
            <button className="hover:text-stone-800">로그아웃</button>
          </form>
        </div>
      </div>
      <h2 className="text-sm font-semibold text-stone-500 mb-2">내 위키</h2>

      {/* 내가 만든 위키 */}
      <ul className="space-y-2 mb-8">
        {owned.length === 0 && <li className="text-gray-500">아직 만든 위키가 없습니다. 아래에서 만들어보세요.</li>}
        {owned.map((w) => (
          <li key={w.id} className="border rounded-lg p-4 hover:bg-gray-50">
            <Link href={`/wikis/${w.slug}`} className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{w.title}</div>
                {w.description && <div className="text-sm text-gray-500">{w.description}</div>}
              </div>
              <div className="text-xs text-gray-400">
                {w.kind} · {w._count.pages} 페이지
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* 공유받은 위키 */}
      {shared.length > 0 && (
        <div className="mb-10">
          <h2 className="text-sm font-semibold text-gray-500 mb-2">공유받은 위키</h2>
          <ul className="space-y-2">
            {shared.map((w) => (
              <li key={w.id} className="border rounded-lg p-4 hover:bg-gray-50">
                <Link href={`/wikis/${w.slug}`} className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{w.title}</div>
                    <div className="text-xs text-gray-400">by {w.createdBy.name ?? w.createdBy.email}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5">{ROLE_LABEL[w.myRole ?? ""] ?? w.myRole}</span>
                    <span>{w._count.pages} 페이지</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form action={createWikiAction} className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">새 위키 만들기</h2>
        <input name="title" required placeholder="위키 제목" className="w-full border rounded px-3 py-2" />
        <select name="kind" className="border rounded px-3 py-2">
          <option value="personal">personal (개인)</option>
          <option value="project">project (프로젝트)</option>
        </select>
        <button type="submit" className="block bg-stone-900 text-white rounded px-4 py-2">
          만들기
        </button>
      </form>
    </main>
  );
}
