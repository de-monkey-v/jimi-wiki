import { NextResponse } from "next/server";
import { apiOrSessionWikiGate } from "@/lib/api-gate";
import { appendDocument, DocumentInputError } from "@/lib/documents";
import {
  contentMutationErrorResponse,
  parseExpectedVersion,
  requestsExternalModelScope,
} from "@/lib/content-api";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; pageSlug: string }> },
) {
  const { id, pageSlug } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const content = typeof body.content === "string"
    ? body.content
    : typeof body.body === "string"
      ? body.body
      : null;
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (content === null) return NextResponse.json({ error: "content_required" }, { status: 400 });
  if (!expectedVersion) return NextResponse.json({ error: "expected_version_required" }, { status: 400 });
  try {
    const result = await appendDocument({
      wikiId: gate.wiki.id,
      userId: gate.user.id,
      actor: requestsExternalModelScope(req) ? "agent" : "human",
      externalAgent: requestsExternalModelScope(req),
      slug: pageSlug,
      content,
      expectedVersion,
    });
    if (result.staged) return NextResponse.json(result, { status: 202 });
    return NextResponse.json({
      appended: true,
      staged: false,
      slug: result.page.slug,
      currentVersion: result.page.currentVersion,
      documentType: result.page.documentType,
      documentAt: result.page.documentAt,
    });
  } catch (error) {
    if (error instanceof DocumentInputError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return contentMutationErrorResponse(error);
  }
}
