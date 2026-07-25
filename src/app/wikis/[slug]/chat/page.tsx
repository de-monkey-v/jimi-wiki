import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { WikiChat } from "./WikiChat";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();

  const t = await getTranslations("WikisSlugChatPage");

  return (
    <main className="mx-auto workspace-measure px-4 py-10 sm:px-6">
      <header className="page-header">
      <div className="page-breadcrumb">
        <Link href="/wikis" className="hover:underline">{t("myWikis")}</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      <p className="page-kicker">Grounded conversation</p>
      <h1 className="page-title">{t("askAi")}</h1>
      <p className="page-description">
        {t("subtitle", { title: wiki.title })}
      </p>
      </header>
      <WikiChat slug={slug} />
    </main>
  );
}
