import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getWikiGraph } from "@/lib/wiki";
import { GraphMount } from "@/components/graph/GraphMount";

export const dynamic = "force-dynamic";

export default async function GraphPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const { nodes, edges } = await getWikiGraph(wiki.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-1 text-sm text-stone-400">
        <Link href={`/wikis/${slug}`} className="hover:underline">← {wiki.title}</Link>
      </div>
      <h1 className="mb-4 text-2xl font-bold">그래프</h1>
      {nodes.length === 0 ? (
        <p className="text-stone-400">아직 페이지가 없습니다.</p>
      ) : (
        <GraphMount nodes={nodes} edges={edges} slug={slug} height={640} controls />
      )}
    </main>
  );
}
