"use server";

import { getCurrentUserId } from "@/lib/session";
import { getPage, getWikiForUser } from "@/lib/wiki";
import { markdownExcerpt } from "@/lib/preview";

export type PagePreview = {
  title: string;
  kind: string;
  documentType: string | null;
  category: string | null;
  excerpt: string;
  updatedAt: string; // ISO
};

/**
 * 내부 링크 hover 미리보기 데이터. quick-nav-actions와 동일한 인증 경계(멤버만) —
 * 미존재·보관 페이지는 null(클라이언트는 카드를 띄우지 않는다).
 */
export async function pagePreviewAction(wikiSlug: string, pageSlug: string): Promise<PagePreview | null> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) return null;
  const page = await getPage(wiki.id, pageSlug);
  if (!page) return null;
  return {
    title: page.title,
    kind: page.kind,
    documentType: page.documentType,
    category: page.category,
    excerpt: markdownExcerpt(page.body),
    updatedAt: page.updatedAt.toISOString(),
  };
}
