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
    <main className="mx-auto workspace-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href={`/wikis/${slug}`}>← {wiki.title}</Link></div>
        <p className="page-kicker">Knowledge map</p>
        <h1 className="page-title">{t("title")}</h1>
      </header>
      {nodes.length === 0 ? (
        <div className="surface-panel p-6">
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
