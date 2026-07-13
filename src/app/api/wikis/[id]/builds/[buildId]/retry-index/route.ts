import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { retryKnowledgeBuildIndexes } from "@/lib/builds";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const { id, buildId } = await params;
  const gate = await sessionWikiGate(id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const build = await prisma.knowledgeBuild.findFirst({ where: { id: buildId, wikiId: gate.wiki.id }, select: { id: true } });
  if (!build) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const result = await retryKnowledgeBuildIndexes(build.id);
    return NextResponse.json({ buildId: build.id, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "retry_failed" }, { status: 409 });
  }
}
