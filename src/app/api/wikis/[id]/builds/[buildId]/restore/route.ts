import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { restoreKnowledgeBuild } from "@/lib/builds";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 전체 snapshot 복원은 owner 사람 세션만 가능하며, 서비스가 checkpoint를 먼저 만든다. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const { id, buildId } = await params;
  const gate = await sessionWikiGate(id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  const build = await prisma.knowledgeBuild.findFirst({
    where: { id: buildId, wikiId: gate.wiki.id },
    select: { id: true, restorable: true, unrestorableReason: true },
  });
  if (!build) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!build.restorable) {
    return NextResponse.json(
      { error: "build_not_restorable", reason: build.unrestorableReason },
      { status: 409 },
    );
  }
  try {
    const result = await restoreKnowledgeBuild(buildId, gate.user.id);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[build-api] build restore failed", error);
    return NextResponse.json({ error: "build_restore_conflict" }, { status: 409 });
  }
}
