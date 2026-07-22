import { NextResponse } from "next/server";
import { apiOrSessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { contentMutationErrorResponse, optionalExpectedVersionFromRequest, requestsExternalModelScope } from "@/lib/content-api";
import { restoreTrashedSource } from "@/lib/trash";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; sourceSlug: string }> }) {
  const { id, sourceSlug } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const requestedVersion = optionalExpectedVersionFromRequest(req);
  if (requestedVersion.state === "invalid") return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
  const source = await prisma.source.findFirst({
    where: {
      wikiId: gate.wiki.id,
      slug: sourceSlug,
      trashedAt: { not: null },
      ...(requestsExternalModelScope(req) ? { modelAccess: "external" as const } : {}),
    },
    select: { id: true, currentVersion: true },
  });
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const restored = await restoreTrashedSource({
      wikiId: gate.wiki.id,
      sourceId: source.id,
      expectedVersion: requestedVersion.state === "valid" ? requestedVersion.value : source.currentVersion,
      userId: gate.user.id,
    });
    return NextResponse.json({ restored: true, slug: restored.slug, currentVersion: restored.currentVersion });
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}
