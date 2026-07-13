// 클라이언트·서버 공용. Next 정적 라우트와 Page.slug가 충돌하지 않게 하는 단일 출처다.
// 새 `/wikis/[slug]/...` 정적 라우트를 추가할 때 이 목록을 함께 갱신한다.
export const ONTOLOGY_PAGE_SLUG = "ontology" as const;

export const STATIC_WIKI_ROUTE_SLUGS = [
  "chat",
  "lint",
  "settings",
  "sources",
  "graph",
  "new",
  "ingest",
  "reading",
  "docs",
  "category",
  "builds",
  "history",
] as const;

export type StaticWikiRouteSlug = (typeof STATIC_WIKI_ROUTE_SLUGS)[number];

const STATIC_ROUTE_SET: ReadonlySet<string> = new Set(STATIC_WIKI_ROUTE_SLUGS);
const RESERVED_PAGE_SLUG_SET: ReadonlySet<string> = new Set([
  ONTOLOGY_PAGE_SLUG,
  ...STATIC_WIKI_ROUTE_SLUGS,
]);

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function isStaticWikiRouteSlug(value: string): boolean {
  return STATIC_ROUTE_SET.has(normalized(value));
}

export function isReservedWikiPageSlug(value: string): boolean {
  return RESERVED_PAGE_SLUG_SET.has(normalized(value));
}
