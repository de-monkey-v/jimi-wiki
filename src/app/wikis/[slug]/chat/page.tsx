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
    <main className="mx-auto workspace-measure px-6 py-10">
      <div className="mb-1 text-sm text-gray-400">
        <Link href="/wikis" className="hover:underline">{t("myWikis")}</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      <h1 className="text-2xl font-bold mb-1">{t("askAi")}</h1>
      <p className="text-sm text-gray-500 mb-4">
        {t("subtitle", { title: wiki.title })}
      </p>
      <WikiChat slug={slug} />
    </main>
  );
}
