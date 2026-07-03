import { notFound } from "next/navigation";
import { getPublicWiki } from "@/lib/wiki";
import { PublicWikiView } from "@/components/PublicWikiView";

export const dynamic = "force-dynamic";

export default async function ChannelPage({ params }: { params: Promise<{ slug: string; pageSlug: string }> }) {
  const { slug: rawSlug, pageSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const wiki = await getPublicWiki(slug);
  if (!wiki) notFound();
  return (
    <PublicWikiView
      wikiId={wiki.id}
      title={wiki.title}
      basePath={`/channels/${encodeURIComponent(slug)}`}
      pageSlug={decodeURIComponent(pageSlug)}
      homeHref="/channels"
      homeLabel="채널"
    />
  );
}
