import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getPage } from "@/lib/wiki";
import { savePageAction } from "../../../actions";

const KINDS = ["note", "concept", "entity", "answer", "meta"] as const;

export default async function EditPage({
  params,
}: {
  params: Promise<{ slug: string; pageSlug: string }>;
}) {
  const { slug: rawSlug, pageSlug: rawPageSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const pageSlug = decodeURIComponent(rawPageSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const page = await getPage(wiki.id, pageSlug);
  if (!page) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 text-sm text-gray-400">
        <Link href={`/wikis/${slug}/${pageSlug}`} className="hover:underline">← {page.title}로 돌아가기</Link>
      </div>

      <form action={savePageAction} className="space-y-4">
        <input type="hidden" name="wikiSlug" value={slug} />
        <input type="hidden" name="pageSlug" value={pageSlug} />

        <div className="flex gap-3">
          <input
            name="title"
            defaultValue={page.title}
            required
            className="flex-1 border rounded px-3 py-2 font-semibold"
          />
          <select name="kind" defaultValue={page.kind} className="border rounded px-3 py-2">
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <textarea
          name="body"
          defaultValue={page.body}
          rows={22}
          placeholder="마크다운으로 작성. 위키링크는 [[페이지-슬러그]] 또는 [[슬러그|표시명]]"
          className="w-full border rounded px-3 py-2 font-mono text-sm"
        />

        <div className="flex gap-2">
          <button type="submit" className="bg-stone-900 text-white rounded px-4 py-2">저장</button>
          <Link href={`/wikis/${slug}/${pageSlug}`} className="border rounded px-4 py-2 hover:bg-gray-50">취소</Link>
        </div>
      </form>
    </main>
  );
}
