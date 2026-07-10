import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getWikiForUser, getWikiToc, listPins, listFolderPins } from "@/lib/wiki";
import { WikiToc } from "@/components/WikiToc";
import { ChatModalProvider } from "./chat/ChatModal";
import { WikiActionsProvider } from "./WikiActions";
import { QuickNavProvider } from "./QuickNav";
import { JobsIndicator } from "./JobsIndicator";

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
  const canWrite = wiki.role !== "viewer";
  const [{ sections }, pagePins, folderPins] = await Promise.all([
    getWikiToc(wiki.id),
    listPins(wiki.id, user.id),
    listFolderPins(wiki.id, user.id),
  ]);
  const pinned = [
    ...pagePins.map((p) => ({ type: "page" as const, slug: p.slug, title: p.title })),
    ...folderPins.map((f) => ({ type: "folder" as const, category: f.category })),
  ];

  return (
    <ChatModalProvider slug={slug} title={wiki.title}>
      <WikiActionsProvider slug={slug} wikiKind={wiki.kind} canWrite={canWrite}>
        <QuickNavProvider slug={slug} canWrite={canWrite}>
          <div className="flex h-dvh overflow-hidden">
            <WikiToc slug={slug} title={wiki.title} email={user.email} role={wiki.role} sections={sections} pinned={pinned} />
            {/* min-w-0: flex 자식 기본 min-width:auto 를 해제 — 없으면 넓은 콘텐츠(코드/표/긴 URL)가
                컬럼을 못 줄여 레이아웃 전체가 가로로 밀린다(모바일 좌우 드래그의 1차 원인).
                pt-12 md:pt-0: 모바일 상단 토글 버튼(fixed) 공간 확보. */}
            <div className="flex-1 min-w-0 overflow-y-auto pt-12 md:pt-0">{children}</div>
          </div>
          <JobsIndicator slug={slug} />
        </QuickNavProvider>
      </WikiActionsProvider>
    </ChatModalProvider>
  );
}
