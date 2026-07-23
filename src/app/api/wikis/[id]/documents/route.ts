import { NextResponse } from "next/server";
import { apiOrSessionWikiGate } from "@/lib/api-gate";
import {
  DocumentInputError,
  parseDocumentDate,
  parseDocumentType,
  writeDocument,
} from "@/lib/documents";
import {
  contentMutationErrorResponse,
  parseExpectedVersion,
  requestsExternalModelScope,
  withExternalModelResponseScope,
} from "@/lib/content-api";
import { normalizeCategoryForWrite } from "@/lib/governance";
import { sanitizeCategorySlug } from "@/lib/ontology";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof DocumentInputError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return contentMutationErrorResponse(error);
}

function filterDate(raw: string | null, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : raw;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiOrSessionWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const url = new URL(req.url);
  const typeRaw = url.searchParams.get("type");
  const type = typeRaw === null ? undefined : parseDocumentType(typeRaw) ?? undefined;
  if (typeRaw !== null && !type) return NextResponse.json({ error: "invalid_document_type" }, { status: 400 });
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const from = filterDate(fromRaw, false);
  const to = filterDate(toRaw, true);
  if ((fromRaw && !from) || (toRaw && !to) || (from && to && from > to)) {
    return NextResponse.json({ error: "invalid_document_range" }, { status: 400 });
  }
  return withExternalModelResponseScope(req, gate.wiki.id, async (tx) => {
    const documents = await tx.page.findMany({
      where: {
        wikiId: gate.wiki.id,
        kind: "document",
        archivedAt: null,
        ...(type ? { documentType: type } : {}),
        ...(from || to
          ? { documentAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
        ...(requestsExternalModelScope(req) ? { modelAccess: "external" } : {}),
      },
      orderBy: [{ documentAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        slug: true,
        title: true,
        body: true,
        documentType: true,
        documentAt: true,
        category: true,
        origin: true,
        modelAccess: true,
        currentVersion: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ documents }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if ("sourceId" in body || "sourceSlug" in body || "sourceRevisionIds" in body) {
    return NextResponse.json({ error: "document_source_provenance_forbidden" }, { status: 400 });
  }
  if (typeof body.title !== "string" || typeof body.body !== "string") {
    return NextResponse.json({ error: "title_and_body_required" }, { status: 400 });
  }
  const rawDocumentType = body.type ?? body.documentType;
  const documentType = rawDocumentType === undefined ? undefined : parseDocumentType(rawDocumentType) ?? undefined;
  const documentAt = body.documentAt === undefined ? undefined : parseDocumentDate(body.documentAt) ?? undefined;
  if (rawDocumentType !== undefined && !documentType) {
    return NextResponse.json({ error: "invalid_document_type" }, { status: 400 });
  }
  if (body.documentAt !== undefined && !documentAt) {
    return NextResponse.json({ error: "invalid_document_at" }, { status: 400 });
  }
  let sourceSlugs: string[] | undefined;
  if (body.sourceSlugs !== undefined) {
    if (!Array.isArray(body.sourceSlugs) || body.sourceSlugs.some((slug) => typeof slug !== "string")) {
      return NextResponse.json({ error: "invalid_research_source_slugs" }, { status: 400 });
    }
    sourceSlugs = body.sourceSlugs as string[];
  }
  if (sourceSlugs !== undefined && documentType !== "research") {
    return NextResponse.json({ error: "document_source_provenance_forbidden" }, { status: 400 });
  }
  const expectedVersion = body.expectedVersion === undefined ? undefined : parseExpectedVersion(body.expectedVersion) ?? undefined;
  if (body.expectedVersion !== undefined && expectedVersion === undefined) {
    return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
  }
  let category: string | null | undefined;
  if (body.category !== undefined) {
    if (body.category !== null && typeof body.category !== "string") {
      return NextResponse.json({ error: "invalid_category" }, { status: 400 });
    }
    category = body.category
      ? requestsExternalModelScope(req)
        ? sanitizeCategorySlug(body.category)
        : await normalizeCategoryForWrite(gate.wiki.id, body.category)
      : null;
  }
  try {
    const result = await writeDocument({
      wikiId: gate.wiki.id,
      userId: gate.user.id,
      actor: requestsExternalModelScope(req) ? "agent" : "human",
      externalAgent: requestsExternalModelScope(req),
      slug: typeof body.slug === "string" ? body.slug : undefined,
      title: body.title,
      body: body.body,
      documentType,
      documentAt,
      category,
      expectedVersion,
      sourceSlugs,
    });
    if (result.staged) return NextResponse.json(result, { status: 202 });
    return NextResponse.json(
      {
        created: result.created,
        staged: false,
        slug: result.page.slug,
        currentVersion: result.page.currentVersion,
        documentType: result.page.documentType,
        documentAt: result.page.documentAt,
        origin: result.page.origin,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
