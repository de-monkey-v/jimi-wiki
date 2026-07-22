import { NextResponse } from "next/server";
import {
  apiOrSessionWikiGate,
  checkGenerativeQuotaResponse,
  hasBearerAuth,
  sessionOnlyGate,
} from "@/lib/api-gate";
import { requestsExternalModelScope } from "@/lib/content-api";
import { createCurateSourceRun } from "@/lib/ingest";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; sourceSlug: string }> },
) {
  const { id, sourceSlug } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const source = await prisma.source.findUnique({
    where: { wikiId_slug: { wikiId: gate.wiki.id, slug: sourceSlug } },
    select: { archivedAt: true, modelAccess: true, curationState: true },
  });
  if (
    !source ||
    source.archivedAt ||
    (requestsExternalModelScope(req) && source.modelAccess !== "external")
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (source.curationState === "curated") {
    return NextResponse.json({ sourceSlug, alreadyCurated: true, status: "curated" });
  }
  const cost = hasBearerAuth(req)
    ? await checkGenerativeQuotaResponse(gate.user.id)
    : await sessionOnlyGate(id, { minRole: "editor" }).then((result) => result.ok ? null : result.res);
  if (cost) return cost;
  try {
    const run = await createCurateSourceRun(gate.wiki.id, sourceSlug, gate.user.id);
    return NextResponse.json(
      { runId: run.id, status: "pending", reused: run.reused, sourceSlug },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}
