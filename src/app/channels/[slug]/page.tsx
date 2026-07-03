import { notFound } from "next/navigation";
import { getPublicWiki } from "@/lib/wiki";
import { PublicWikiView } from "@/components/PublicWikiView";

export const dynamic = "force-dynamic";

export default async function ChannelWiki({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const wiki = await getPublicWiki(slug);
  if (!wiki) notFound();
  return (
    <PublicWikiView
      wikiId={wiki.id}
      title={wiki.title}
      basePath={`/channels/${encodeURIComponent(slug)}`}
      homeHref="/channels"
      homeLabel="채널"
    />
  );
}
