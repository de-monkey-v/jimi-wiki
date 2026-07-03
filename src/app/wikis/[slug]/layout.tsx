import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getWikiForUser, getWikiToc } from "@/lib/wiki";
import { WikiToc } from "@/components/WikiToc";
import { ChatModalProvider } from "./chat/ChatModal";

// 위키 안에서는 좌측 사이드바가 그 위키의 책 목차(TOC)로 전환된다.
export default async function WikiLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const wiki = await getWikiForUser(user.id, slug);
  if (!wiki) notFound(); // 멤버 아니면 제목 유출 없이 404
  const { sections } = await getWikiToc(wiki.id);

  return (
    <ChatModalProvider slug={slug} title={wiki.title} canWrite={wiki.role !== "viewer"}>
      <div className="flex h-dvh overflow-hidden">
        <WikiToc slug={slug} title={wiki.title} email={user.email} role={wiki.role} sections={sections} />
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </ChatModalProvider>
  );
}
