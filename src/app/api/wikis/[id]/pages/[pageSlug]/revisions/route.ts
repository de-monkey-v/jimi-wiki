import { NextResponse } from "next/server";
import { sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { restorePageRevisionTx } from "@/lib/content-store";
import { refreshPageDerivedState } from "@/lib/page-projections";
import { contentMutationErrorResponse, parseExpectedVersion } from "@/lib/content-api";
import { isReservedSlug } from "@/lib/ontology";
import { reindexEmbeddings } from "@/lib/search";
import { withModelPolicyWriteLock } from "@/lib/model-access";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; pageSlug: string }> },
) {
  const { id, pageSlug } = await params;
  const gate = await sessionWikiGate(id);
  if (!gate.ok) return gate.res;
  const page = await prisma.page.findUnique({
    where: { wikiId_slug: { wikiId: gate.wiki.id, slug: pageSlug } },
    select: { id: true, slug: true, title: true, currentVersion: true, archivedAt: true },
  });
  if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const revisions = await prisma.pageRevision.findMany({
    where: { pageId: page.id },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      title: true,
      body: true,
      kind: true,
      frontmatter: true,
      category: true,
      parentId: true,
      sortOrder: true,
      sourceId: true,
      origin: true,
      modelAccess: true,
      archivedAt: true,
      suppressedAt: true,
      staleAt: true,
      contentHash: true,
      actor: true,
      reason: true,
      userId: true,
      agentRunId: true,
      buildId: true,
      createdAt: true,
      sources: { select: { sourceRevisionId: true } },
    },
  });
  return NextResponse.json({ page, revisions }, { headers: { "Cache-Control": "no-store" } });
}

/** 선택한 과거 snapshot을 새 현재 revision으로 복사한다. 과거 정책보다 현재 정책을 우선한다. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; pageSlug: string }> },
) {
  const { id, pageSlug } = await params;
  const gate = await sessionWikiGate(id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  if (isReservedSlug(pageSlug)) {
    return NextResponse.json({ error: "cannot_restore_system_page" }, { status: 403 });
  }
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

  const page = await prisma.page.findUnique({
    where: { wikiId_slug: { wikiId: gate.wiki.id, slug: pageSlug } },
    select: { id: true },
  });
  if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const result = await withModelPolicyWriteLock(gate.wiki.id, (tx) => restorePageRevisionTx(tx, {
      wikiId: gate.wiki.id,
      pageId: page.id,
      expectedVersion,
      revisionId,
      context: { actor: "restore", userId: gate.user.id, reason: `page revision restored: ${revisionId}` },
    }));
    await refreshPageDerivedState(gate.wiki.id, result.page.id);
    if (result.page.modelAccess === "external" && result.page.kind !== "personal" && !result.page.archivedAt) {
      await reindexEmbeddings(gate.wiki.id).catch(() => null);
    }
    return NextResponse.json(
      {
        restored: true,
        slug: result.page.slug,
        origin: result.page.origin,
        modelAccess: result.page.modelAccess,
        currentVersion: result.page.currentVersion,
        archivedAt: result.page.archivedAt,
        revisionId: result.revision.id,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}
