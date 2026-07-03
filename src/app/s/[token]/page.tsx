import { notFound } from "next/navigation";
import { resolveShareLink } from "@/lib/members";
import { PublicWikiView } from "@/components/PublicWikiView";

export const dynamic = "force-dynamic";

/** 공유 링크 홈(인증 없는 읽기 전용). */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await resolveShareLink(token);
  if (!link) notFound();
  return <PublicWikiView wikiId={link.wikiId} title={link.wiki.title} basePath={`/s/${token}`} />;
}
