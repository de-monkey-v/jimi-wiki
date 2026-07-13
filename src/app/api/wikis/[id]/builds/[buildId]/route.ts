import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const { id, buildId } = await params;
  const gate = await sessionWikiGate(id);
  if (!gate.ok) return gate.res;
  const rawPage = Number(new URL(req.url).searchParams.get("draftPage") ?? "0");
  const draftPage = Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0;
  const draftPageSize = 50;
  const build = await prisma.knowledgeBuild.findFirst({
    where: { id: buildId, wikiId: gate.wiki.id },
    include: {
      drafts: {
        orderBy: [{ status: "asc" }, { slug: "asc" }],
        skip: draftPage * draftPageSize,
        take: draftPageSize,
        include: {
          sources: { select: { sourceRevisionId: true } },
          page: { select: { title: true, body: true, category: true, currentVersion: true, origin: true, modelAccess: true } },
        },
      },
      _count: { select: { pageManifest: true, drafts: true } },
    },
  });
  if (!build) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { build, draftPage, draftPageSize },
    { headers: { "Cache-Control": "no-store" } },
  );
}
