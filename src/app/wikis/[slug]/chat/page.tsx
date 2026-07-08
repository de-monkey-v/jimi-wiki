import Link from "next/link";
import { notFound } from "next/navigation";
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

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-1 text-sm text-gray-400">
        <Link href="/wikis" className="hover:underline">내 위키</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      <h1 className="text-2xl font-bold mb-1">AI에게 질문</h1>
      <p className="text-sm text-gray-500 mb-4">
        {wiki.title}의 지식(원문·개념·개체)을 근거로 답합니다.
      </p>
      <WikiChat slug={slug} />
    </main>
  );
}
