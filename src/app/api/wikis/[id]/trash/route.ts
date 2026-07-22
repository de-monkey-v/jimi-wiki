import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { isReservedSlug } from "@/lib/ontology";
import { requestsExternalModelScope } from "@/lib/content-api";

export const dynamic = "force-dynamic";

/** GET — MCP/REST가 복원할 수 있는 휴지통 항목. 위키 전체와 영구 삭제는 노출하지 않는다. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const external = requestsExternalModelScope(req);
  const [savedLinks, rawPages, sources] = await Promise.all([
    prisma.savedLink.findMany({
      where: { wikiId: gate.wiki.id, userId: gate.user.id, trashedAt: { not: null } },
      orderBy: { trashedAt: "desc" },
      select: { id: true, url: true, title: true, summary: true, trashedAt: true, purgeAt: true },
    }),
    prisma.page.findMany({
      where: {
        wikiId: gate.wiki.id,
        trashedAt: { not: null },
        origin: { not: "system" },
        ...(external ? { modelAccess: "external" as const, kind: { not: "personal" as const } } : {}),
      },
      orderBy: { trashedAt: "desc" },
      select: { slug: true, title: true, kind: true, currentVersion: true, sourceId: true, trashedAt: true, purgeAt: true },
    }),
    prisma.source.findMany({
      where: {
        wikiId: gate.wiki.id,
        trashedAt: { not: null },
        ...(external ? { modelAccess: "external" as const } : {}),
      },
      orderBy: { trashedAt: "desc" },
      select: { slug: true, title: true, currentVersion: true, trashedAt: true, purgeAt: true },
    }),
  ]);
  const pages = rawPages.filter((page) => !isReservedSlug(page.slug) && !(page.kind === "note" && page.sourceId));
  return NextResponse.json({ savedLinks, pages, sources }, { headers: { "Cache-Control": "no-store" } });
}
