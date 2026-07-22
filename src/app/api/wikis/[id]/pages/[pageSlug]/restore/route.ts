import { NextResponse } from "next/server";
import { apiOrSessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { contentMutationErrorResponse, optionalExpectedVersionFromRequest, requestsExternalModelScope } from "@/lib/content-api";
import { restoreTrashedPage } from "@/lib/trash";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; pageSlug: string }> }) {
  const { id, pageSlug } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const requestedVersion = optionalExpectedVersionFromRequest(req);
  if (requestedVersion.state === "invalid") return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
  const page = await prisma.page.findFirst({
    where: {
      wikiId: gate.wiki.id,
      slug: pageSlug,
      trashedAt: { not: null },
      origin: { not: "system" },
      ...(requestsExternalModelScope(req) ? { modelAccess: "external" as const, kind: { not: "personal" as const } } : {}),
    },
    select: { id: true, currentVersion: true },
  });
  if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const restored = await restoreTrashedPage({
      wikiId: gate.wiki.id,
      pageId: page.id,
      expectedVersion: requestedVersion.state === "valid" ? requestedVersion.value : page.currentVersion,
      userId: gate.user.id,
    });
    return NextResponse.json({ restored: true, slug: restored.slug, currentVersion: restored.currentVersion });
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}
