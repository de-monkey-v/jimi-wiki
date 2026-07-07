import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { listMembers, listShareLinks } from "@/lib/members";
import {
  updateWikiSettingsAction,
  deleteWikiAction,
  inviteMemberAction,
  updateMemberRoleAction,
  removeMemberAction,
  createShareLinkAction,
  revokeShareLinkAction,
} from "../../manage-actions";

const ROLES = ["viewer", "editor", "owner"] as const;

export default async function WikiSettings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  if (wiki.role !== "owner") {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <Link href={`/wikis/${slug}`} className="text-sm text-gray-400 hover:underline">← {wiki.title}</Link>
        <p className="mt-6 text-gray-500">이 위키의 설정은 owner만 볼 수 있습니다. (현재 역할: {wiki.role})</p>
      </main>
    );
  }

  const members = await listMembers(wiki.id);
  const links = await listShareLinks(wiki.id);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
      <div>
        <Link href={`/wikis/${slug}`} className="text-sm text-gray-400 hover:underline">← {wiki.title}</Link>
        <h1 className="text-2xl font-bold mt-1">위키 설정</h1>
      </div>

      {/* 일반 설정 */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">일반</h2>
        <form action={updateWikiSettingsAction} className="space-y-3">
          <input type="hidden" name="wikiSlug" value={slug} />
          <label className="block text-sm">
            제목
            <input name="title" defaultValue={wiki.title} className="mt-1 w-full border rounded px-3 py-2" />
          </label>
          <label className="block text-sm">
            설명
            <input name="description" defaultValue={wiki.description ?? ""} className="mt-1 w-full border rounded px-3 py-2" />
          </label>
          <label className="block text-sm">
            공개 범위
            <select name="visibility" defaultValue={wiki.visibility} className="mt-1 block border rounded px-3 py-2">
              <option value="private">private (멤버만)</option>
              <option value="unlisted">unlisted (링크 공유)</option>
            </select>
          </label>
          <button className="bg-stone-900 text-white rounded px-4 py-2">저장</button>
        </form>
      </section>

      {/* 멤버 */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">멤버</h2>
        <ul className="space-y-2">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-2 text-sm">
              <span>{m.user.name ?? m.user.email}</span>
              <div className="flex items-center gap-1">
                <form action={updateMemberRoleAction} className="flex items-center gap-1">
                  <input type="hidden" name="wikiSlug" value={slug} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <select name="role" defaultValue={m.role} className="border rounded px-2 py-1">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="border rounded px-2 py-1 hover:bg-gray-50">변경</button>
                </form>
                <form action={removeMemberAction}>
                  <input type="hidden" name="wikiSlug" value={slug} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button className="border rounded px-2 py-1 text-red-600 hover:bg-red-50">제거</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
        <form action={inviteMemberAction} className="flex gap-2 pt-2 border-t">
          <input type="hidden" name="wikiSlug" value={slug} />
          <input name="email" type="email" required placeholder="초대할 이메일" className="flex-1 border rounded px-3 py-2 text-sm" />
          <select name="role" defaultValue="viewer" className="border rounded px-2 py-2 text-sm">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="bg-stone-900 text-white rounded px-3 py-2 text-sm">초대</button>
        </form>
      </section>

      {/* 공유 링크 */}
      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">공유 링크 (읽기 전용)</h2>
        <ul className="space-y-2">
          {links.length === 0 && <li className="text-sm text-gray-400">아직 없음.</li>}
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <code className="text-xs bg-gray-100 px-2 py-1 rounded truncate">/s/{l.token}</code>
              <form action={revokeShareLinkAction}>
                <input type="hidden" name="wikiSlug" value={slug} />
                <input type="hidden" name="linkId" value={l.id} />
                <button className="border rounded px-2 py-1 text-red-600 hover:bg-red-50">폐기</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={createShareLinkAction}>
          <input type="hidden" name="wikiSlug" value={slug} />
          <button className="border rounded px-3 py-2 text-sm hover:bg-gray-50">+ 공유 링크 생성</button>
        </form>
      </section>

      {/* 위험 구역 */}
      <section className="border border-red-200 rounded-lg p-4 space-y-3">
        <h2 className="font-semibold text-red-700">위험 구역</h2>
        <form action={deleteWikiAction}>
          <input type="hidden" name="wikiSlug" value={slug} />
          <button className="bg-red-600 text-white rounded px-4 py-2 text-sm">이 위키 삭제 (되돌릴 수 없음)</button>
        </form>
      </section>
    </main>
  );
}
