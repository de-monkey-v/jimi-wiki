import { NextResponse } from "next/server";
import { apiWikiGate, sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { isReservedSlug } from "@/lib/ontology";
import { purgePage } from "@/lib/content-store";
import { changePageModelAccess } from "@/lib/model-policy";
import { ONTOLOGY_PAGE_SLUG } from "@/lib/wiki-routes";
import { trashPage } from "@/lib/trash";
import {
  contentMutationErrorResponse,
  optionalExpectedVersionFromRequest,
  parseExpectedVersion,
  parseModelAccess,
  purgeConfirmationMatches,
  requestsExternalModelScope,
  withExternalModelResponseScope,
} from "@/lib/content-api";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/pages/:pageSlug — 페이지 단건(본문 포함). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; pageSlug: string }> }) {
  const { id, pageSlug } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  return withExternalModelResponseScope(req, gate.wiki.id, async (tx) => {
    const page = await tx.page.findFirst({
      where: {
        wikiId: gate.wiki.id,
        slug: requestsExternalModelScope(req)
          ? { equals: pageSlug, not: ONTOLOGY_PAGE_SLUG }
          : pageSlug,
        archivedAt: null,
        ...(requestsExternalModelScope(req)
          ? {
              modelAccess: "external" as const,
              kind: { not: "personal" as const },
            }
          : {}),
      },
    });
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(
      {
        slug: page.slug,
        title: page.title,
        kind: page.kind,
        documentType: page.documentType,
        documentAt: page.documentAt,
        category: page.category,
        body: page.body,
        origin: page.origin,
        modelAccess: page.modelAccess,
        currentVersion: page.currentVersion,
        archivedAt: page.archivedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

/** PATCH /api/wikis/:id/pages/:pageSlug — AI 데이터 흐름 정책 변경(editor). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; pageSlug: string }> }) {
  const { id, pageSlug } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  let body: { modelAccess?: unknown; expectedVersion?: unknown; confirmExternalAccess?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const modelAccess = parseModelAccess(body?.modelAccess);
  const expectedVersion = parseExpectedVersion(body?.expectedVersion);
  if (!modelAccess) return NextResponse.json({ error: "invalid_model_access" }, { status: 400 });
  if (!expectedVersion) return NextResponse.json({ error: "expected_version_required" }, { status: 400 });

  const page = await prisma.page.findFirst({
    where: { wikiId: gate.wiki.id, slug: pageSlug, trashedAt: null },
    select: { id: true, modelAccess: true },
  });
  if (!page || (requestsExternalModelScope(req) && page.modelAccess !== "external")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const result = await changePageModelAccess({
      wikiId: gate.wiki.id,
      pageId: page.id,
      expectedVersion,
      modelAccess,
      confirmExternalAccess: body.confirmExternalAccess === true,
      userId: gate.user.id,
      reason: "page policy changed through REST",
    });
    return NextResponse.json(
      {
        slug: result.page.slug,
        origin: result.page.origin,
        modelAccess: result.page.modelAccess,
        currentVersion: result.page.currentVersion,
        archivedAt: result.page.archivedAt,
        revisionId: result.revision.id,
        policy: result.plan,
        signals: result.signals,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}

/**
 * DELETE는 기본적으로 14일 복구 가능한 휴지통 이동이다. 영구 삭제는 이미 휴지통에 있는
 * 항목에 한해 owner 세션·쿼리·slug 확인 헤더를 모두 요구한다.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; pageSlug: string }> }) {
  const { id, pageSlug } = await params;
  const permanent = new URL(req.url).searchParams.get("permanent") === "1";

  if (permanent) {
    const gate = await sessionWikiGate(id, { minRole: "owner" });
    if (!gate.ok) return gate.res;
    const requestedVersion = optionalExpectedVersionFromRequest(req);
    if (requestedVersion.state === "invalid") {
      return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
    }
    if (!purgeConfirmationMatches(req, pageSlug)) {
      return NextResponse.json({ error: "purge_confirmation_required" }, { status: 400 });
    }
    const page = await prisma.page.findUnique({
      where: { wikiId_slug: { wikiId: gate.wiki.id, slug: pageSlug } },
      select: { id: true, slug: true, currentVersion: true, trashedAt: true },
    });
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (isReservedSlug(page.slug)) {
      return NextResponse.json({ error: "cannot_delete_system_page" }, { status: 403 });
    }
    if (!page.trashedAt) {
      return NextResponse.json({ error: "must_trash_first" }, { status: 409 });
    }
    try {
      await purgePage({
        wikiId: gate.wiki.id,
        pageId: page.id,
        expectedVersion: requestedVersion.state === "valid" ? requestedVersion.value : page.currentVersion,
      });
      return NextResponse.json(
        { deleted: true, purged: true, slug: page.slug },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return contentMutationErrorResponse(error);
    }
  }

  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const requestedVersion = optionalExpectedVersionFromRequest(req);
  if (requestedVersion.state === "invalid") {
    return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
  }
  const page = await prisma.page.findFirst({
    where: {
      wikiId: gate.wiki.id,
      slug: pageSlug,
      trashedAt: null,
      origin: { not: "system" },
      ...(requestsExternalModelScope(req)
        ? { modelAccess: "external" as const, kind: { not: "personal" as const } }
        : {}),
    },
    select: { id: true, slug: true, currentVersion: true, kind: true, sourceId: true },
  });
  if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (isReservedSlug(page.slug)) {
    return NextResponse.json({ error: "cannot_delete_system_page" }, { status: 403 });
  }
  try {
    await trashPage({
      wikiId: gate.wiki.id,
      pageId: page.id,
      expectedVersion: requestedVersion.state === "valid" ? requestedVersion.value : page.currentVersion,
      userId: gate.user.id,
    });
    return NextResponse.json(
      { deleted: true, trashed: true, slug: page.slug },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "source_note_requires_source_trash") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message === "system_page_cannot_be_trashed") {
      return NextResponse.json({ error: "cannot_delete_system_page" }, { status: 403 });
    }
    return contentMutationErrorResponse(error);
  }
}
