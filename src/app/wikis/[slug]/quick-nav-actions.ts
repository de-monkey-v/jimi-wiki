"use server";

import { prisma } from "@/lib/db";
import { getCurrentUserId } from "@/lib/session";
import { localFtsSearch } from "@/lib/search";
import { getWikiForUser } from "@/lib/wiki";
import { ONTOLOGY_SLUG } from "@/lib/ontology";

export type QuickNavSearchItem = {
  key: string;
  refType: "page" | "source";
  slug: string;
  title: string;
  kind: string;
  heading: string | null;
  snippet: string | null;
};

const RESULT_LIMIT = 40;
const QUERY_MAX = 200;

/**
 * 인증된 UI 전용 로컬 탐색. 로컬 PostgreSQL FTS만 쓰며 query embedding/외부 모델을 호출하지 않는다.
 * 빈 질의는 기존 Quick Switcher 규약처럼 active Page 제목 목록을 반환한다.
 */
export async function quickNavSearchAction(wikiSlug: string, rawQuery: string): Promise<QuickNavSearchItem[]> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("not_found");

  const query = rawQuery.trim().slice(0, QUERY_MAX);
  if (!query) {
    const pages = await prisma.page.findMany({
      where: { wikiId: wiki.id, archivedAt: null, slug: { not: ONTOLOGY_SLUG } },
      orderBy: [{ kind: "asc" }, { title: "asc" }],
      take: RESULT_LIMIT,
      select: { slug: true, title: true, kind: true },
    });
    return pages.map((page) => ({
      key: `page:${page.slug}`,
      refType: "page",
      slug: page.slug,
      title: page.title,
      kind: page.kind,
      heading: null,
      snippet: null,
    }));
  }

  const hits = await localFtsSearch(wiki.id, query, RESULT_LIMIT);
  const pageIds = hits.filter((hit) => hit.refType === "page").map((hit) => hit.refId);
  const sourceIds = hits.filter((hit) => hit.refType === "source").map((hit) => hit.refId);
  const [pages, sources] = await Promise.all([
    pageIds.length
      ? prisma.page.findMany({
          where: { wikiId: wiki.id, archivedAt: null, id: { in: pageIds } },
          select: { id: true, slug: true, title: true, kind: true },
        })
      : [],
    sourceIds.length
      ? prisma.source.findMany({
          where: { wikiId: wiki.id, archivedAt: null, id: { in: sourceIds } },
          select: { id: true, slug: true, title: true },
        })
      : [],
  ]);
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  return hits.flatMap((hit): QuickNavSearchItem[] => {
    if (hit.refType === "page") {
      const page = pageById.get(hit.refId);
      if (!page || page.slug === ONTOLOGY_SLUG) return [];
      return [
        {
          key: `page:${page.slug}`,
          refType: "page",
          slug: page.slug,
          title: page.title,
          kind: page.kind,
          heading: hit.heading || null,
          snippet: hit.snippet || null,
        },
      ];
    }
    if (hit.refType === "source") {
      const source = sourceById.get(hit.refId);
      if (!source) return [];
      return [
        {
          key: `source:${source.slug}`,
          refType: "source",
          slug: source.slug,
          title: source.title,
          kind: "source",
          heading: hit.heading || null,
          snippet: hit.snippet || null,
        },
      ];
    }
    return [];
  });
}
