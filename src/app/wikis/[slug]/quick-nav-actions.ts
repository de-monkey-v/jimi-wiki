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
  documentType: string | null;
  heading: string | null;
  snippet: string | null;
  group: "protected" | "knowledge" | "documents" | "sources" | null;
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
      where: {
        wikiId: wiki.id,
        archivedAt: null,
        trashedAt: null,
        slug: { not: ONTOLOGY_SLUG },
        kind: { not: "note" },
      },
      orderBy: [{ kind: "asc" }, { title: "asc" }],
      take: RESULT_LIMIT,
      select: { slug: true, title: true, kind: true, documentType: true },
    });
    return pages.map((page) => ({
      key: `page:${page.slug}`,
      refType: "page",
      slug: page.slug,
      title: page.title,
      kind: page.kind,
      documentType: page.documentType,
      heading: null,
      snippet: null,
      group: null,
    }));
  }

  const perGroupLimit = Math.floor(RESULT_LIMIT / 3);
  const [protectedHits, knowledgeHits, documentHits] = await Promise.all([
    localFtsSearch(wiki.id, query, perGroupLimit, "protected"),
    localFtsSearch(wiki.id, query, perGroupLimit, "knowledge"),
    localFtsSearch(wiki.id, query, perGroupLimit, "documents"),
  ]);
  const hits = [
    ...protectedHits.map((hit) => ({ hit, group: "protected" as const })),
    ...knowledgeHits.map((hit) => ({ hit, group: "knowledge" as const })),
    ...documentHits.map((hit) => ({ hit, group: "documents" as const })),
  ];
  const pageIds = hits.filter(({ hit }) => hit.refType === "page").map(({ hit }) => hit.refId);
  const sourceIds = hits.filter(({ hit }) => hit.refType === "source").map(({ hit }) => hit.refId);
  const [pages, sources] = await Promise.all([
    pageIds.length
      ? prisma.page.findMany({
          where: { wikiId: wiki.id, archivedAt: null, trashedAt: null, id: { in: pageIds } },
          select: {
            id: true,
            slug: true,
            title: true,
            kind: true,
            documentType: true,
            source: { select: { slug: true, title: true } },
          },
        })
      : [],
    sourceIds.length
      ? prisma.source.findMany({
          where: { wikiId: wiki.id, archivedAt: null, trashedAt: null, id: { in: sourceIds } },
          select: { id: true, slug: true, title: true },
        })
      : [],
  ]);
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const rawSourceSlugs = new Set(sources.map((source) => source.slug));

  const items: QuickNavSearchItem[] = [];
  const seen = new Set<string>();
  for (const { hit, group } of hits) {
    if (hit.refType === "page") {
      const page = pageById.get(hit.refId);
      if (!page || page.slug === ONTOLOGY_SLUG) continue;
      if (page.kind === "note") {
        if (!page.source) continue;
        // 같은 Source 원문 hit가 있으면 그것을 우선해 projection note의 기술 스니펫을 노출하지 않는다.
        if (rawSourceSlugs.has(page.source.slug)) continue;
        const key = `source:${page.source.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          key,
          refType: "source",
          slug: page.source.slug,
          title: page.source.title,
          kind: "source",
          documentType: null,
          heading: null,
          snippet: null,
          group: "sources",
        });
      } else {
        const key = `page:${page.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          key: `page:${page.slug}`,
          refType: "page",
          slug: page.slug,
          title: page.title,
          kind: page.kind,
          documentType: page.documentType,
          heading: hit.heading || null,
          snippet: hit.snippet || null,
          group,
        });
      }
    }
    if (hit.refType === "source") {
      const source = sourceById.get(hit.refId);
      if (!source) continue;
      const key = `source:${source.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        key,
        refType: "source",
        slug: source.slug,
        title: source.title,
        kind: "source",
        documentType: null,
        heading: hit.heading || null,
        snippet: hit.snippet || null,
        group: "sources",
      });
    }
  }
  const groupOrder: Record<Exclude<QuickNavSearchItem["group"], null>, number> = {
    protected: 0,
    knowledge: 1,
    documents: 2,
    sources: 3,
  };
  return items.sort((a, b) => {
    if (!a.group || !b.group) return 0;
    return groupOrder[a.group] - groupOrder[b.group];
  });
}
