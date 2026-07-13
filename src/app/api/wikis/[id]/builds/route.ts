import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await sessionWikiGate(id);
  if (!gate.ok) return gate.res;
  const builds = await prisma.knowledgeBuild.findMany({
    where: { wikiId: gate.wiki.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      mode: true,
      status: true,
      model: true,
      costUsd: true,
      restorable: true,
      unrestorableReason: true,
      forceExtraction: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      publishedAt: true,
      _count: { select: { drafts: true, pageManifest: true } },
    },
  });
  return NextResponse.json({ builds }, { headers: { "Cache-Control": "no-store" } });
}
