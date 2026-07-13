import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { restoreSourceRevisionWithPropagation } from "@/lib/model-policy";
import { contentMutationErrorResponse, parseExpectedVersion } from "@/lib/content-api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; sourceSlug: string }> },
) {
  const { id, sourceSlug } = await params;
  const gate = await sessionWikiGate(id);
  if (!gate.ok) return gate.res;
  const source = await prisma.source.findUnique({
    where: { wikiId_slug: { wikiId: gate.wiki.id, slug: sourceSlug } },
    select: { id: true, slug: true, title: true, currentVersion: true, archivedAt: true },
  });
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const revisions = await prisma.sourceRevision.findMany({
    where: { sourceId: source.id },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      title: true,
      url: true,
      body: true,
      storageKey: true,
      modelAccess: true,
      archivedAt: true,
      contentHash: true,
      actor: true,
      reason: true,
      userId: true,
      agentRunId: true,
      buildId: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ source, revisions }, { headers: { "Cache-Control": "no-store" } });
}

/** Source snapshot 복원. 정책 downgrade/archive의 dependent Page 효과도 먼저 fail-closed로 적용한다. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; sourceSlug: string }> },
) {
  const { id, sourceSlug } = await params;
  const gate = await sessionWikiGate(id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  let body: { revisionId?: unknown; expectedVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const revisionId = typeof body?.revisionId === "string" ? body.revisionId.trim() : "";
  const expectedVersion = parseExpectedVersion(body?.expectedVersion);
  if (!revisionId) return NextResponse.json({ error: "revision_id_required" }, { status: 400 });
  if (!expectedVersion) return NextResponse.json({ error: "expected_version_required" }, { status: 400 });

  const source = await prisma.source.findUnique({
    where: { wikiId_slug: { wikiId: gate.wiki.id, slug: sourceSlug } },
    select: { id: true },
  });
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const result = await restoreSourceRevisionWithPropagation({
      wikiId: gate.wiki.id,
      sourceId: source.id,
      expectedVersion,
      revisionId,
      userId: gate.user.id,
      reason: `source revision restored: ${revisionId}`,
    });
    return NextResponse.json(
      {
        restored: true,
        slug: result.source.slug,
        modelAccess: result.source.modelAccess,
        currentVersion: result.source.currentVersion,
        archivedAt: result.source.archivedAt,
        revisionId: result.revision.id,
        signals: result.signals,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}
