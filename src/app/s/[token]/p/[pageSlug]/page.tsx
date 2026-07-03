import { notFound } from "next/navigation";
import { resolveShareLink } from "@/lib/members";
import { PublicWikiView } from "@/components/PublicWikiView";

export const dynamic = "force-dynamic";

export default async function SharePageView({ params }: { params: Promise<{ token: string; pageSlug: string }> }) {
  const { token, pageSlug } = await params;
  const link = await resolveShareLink(token);
  if (!link) notFound();
  return (
    <PublicWikiView
      wikiId={link.wikiId}
      title={link.wiki.title}
      basePath={`/s/${token}`}
      pageSlug={decodeURIComponent(pageSlug)}
    />
  );
}
