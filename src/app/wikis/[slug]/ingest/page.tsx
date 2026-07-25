import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { IngestPanel } from "../IngestPanel";

/** 소스 편입 모달의 직접 접근·새로고침용 전체 페이지. */
export default async function IngestPage({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations("WikisSlugWikiActions");
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  if (wiki.role === "viewer") redirect(`/wikis/${encodeURIComponent(slug)}`);

  return (
    <main className="mx-auto compact-measure px-4 py-10 sm:px-6">
      <header className="page-header">
        <div className="page-breadcrumb"><Link href={`/wikis/${encodeURIComponent(slug)}`}>← {wiki.title}</Link></div>
        <p className="page-kicker">Source intake</p>
        <h1 className="page-title">{t("ingestTitle")}</h1>
      </header>
      <div className="surface-panel p-4 sm:p-5">
      <IngestPanel wikiSlug={slug} />
      </div>
    </main>
  );
}
