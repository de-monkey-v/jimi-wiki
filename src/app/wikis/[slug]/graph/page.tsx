import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getWikiGraph } from "@/lib/wiki";
import { EmptyState } from "@/components/EmptyState";
import { GraphMount } from "@/components/graph/GraphMount";

export const dynamic = "force-dynamic";

export default async function GraphPage({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugGraphPage");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const { nodes, edges } = await getWikiGraph(wiki.id);

  return (
    <main className="mx-auto workspace-measure px-6 py-8">
      <div className="mb-1 text-sm text-stone-400">
        <Link href={`/wikis/${slug}`} className="hover:underline">← {wiki.title}</Link>
      </div>
      <h1 className="mb-4 text-2xl font-bold">{t("title")}</h1>
      {nodes.length === 0 ? (
        <div className="rounded-lg border border-stone-200 bg-white p-6">
          <EmptyState
            asset="empty-graph"
            title={t("emptyTitle")}
            body={t("emptyBody")}
          />
        </div>
      ) : (
        <GraphMount nodes={nodes} edges={edges} slug={slug} height={640} controls />
      )}
    </main>
  );
}
