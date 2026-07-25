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
    <main className="mx-auto compact-measure px-6 py-10">
      <Link href={`/wikis/${encodeURIComponent(slug)}`} className="text-sm text-stone-400 hover:text-stone-600 hover:underline">
        ← {wiki.title}
      </Link>
      <h1 className="mb-5 mt-1 text-2xl font-bold">{t("ingestTitle")}</h1>
      <IngestPanel wikiSlug={slug} />
    </main>
  );
}
