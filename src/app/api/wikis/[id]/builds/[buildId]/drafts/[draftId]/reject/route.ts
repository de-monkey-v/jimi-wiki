import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { rejectKnowledgeDraft } from "@/lib/builds";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** conflict draft 거절은 editor 이상 사람 세션만 가능하다. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; buildId: string; draftId: string }> },
) {
  const { id, buildId, draftId } = await params;
  const gate = await sessionWikiGate(id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const draft = await prisma.knowledgeDraft.findFirst({
    where: { id: draftId, buildId, build: { wikiId: gate.wiki.id } },
    select: { id: true },
  });
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const build = await rejectKnowledgeDraft(buildId, draftId);
    return NextResponse.json({ rejected: true, build }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[build-api] draft reject failed", error);
    return NextResponse.json({ error: "draft_reject_conflict" }, { status: 409 });
  }
}
