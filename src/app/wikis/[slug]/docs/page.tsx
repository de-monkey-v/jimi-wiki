import DocsPage from "@/app/docs/page";

/** 위키 셸 안 연동 가이드의 직접 접근·새로고침용 전체 페이지. */
export default async function WikiDocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);

  return <DocsPage searchParams={Promise.resolve({ wiki: slug })} />;
}
