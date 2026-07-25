export type RecentKind = "document" | "concept" | "entity";
export type RecentPage = { slug: string; title: string; kind: RecentKind };

export const RECENT_LIMIT = 8;
export const recentKey = (wikiSlug: string) => `jimi:recent:v2:${wikiSlug}`;

export function parseRecentPages(value: string | null): RecentPage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentPage => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<RecentPage>;
      return (
        typeof candidate.slug === "string" &&
        typeof candidate.title === "string" &&
        (candidate.kind === "document" || candidate.kind === "concept" || candidate.kind === "entity")
      );
    }).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function addRecentPage(items: RecentPage[], item: RecentPage): RecentPage[] {
  return [item, ...items.filter((entry) => entry.slug !== item.slug)].slice(0, RECENT_LIMIT);
}
