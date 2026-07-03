import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getSource } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";

// 원문(Source) 읽기 전용 뷰어 — 소스 노트의 provenance 링크 타겟. 불변·원문 그대로.
export default async function SourceView({
  params,
}: {
  params: Promise<{ slug: string; sourceSlug: string }>;
}) {
  const { slug: rawSlug, sourceSlug: rawSourceSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const sourceSlug = decodeURIComponent(rawSourceSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  const source = await getSource(wiki.id, sourceSlug);
  if (!source) notFound();

  const html = await renderMarkdown(source.body ?? "", { hrefFor: () => "#", exists: () => false });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-1 text-sm text-stone-400">
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link> / 원문
      </div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{source.title}</h1>
        <span className="shrink-0 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-500">원문 · 읽기 전용</span>
      </div>
      {source.url && (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 block truncate text-sm text-blue-600 hover:underline"
        >
          {source.url}
        </a>
      )}
      {(source.body ?? "").trim() === "" ? (
        <p className="text-stone-400">원문 본문이 없습니다.</p>
      ) : (
        <article className="wiki-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </main>
  );
}
