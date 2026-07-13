import { NextResponse } from "next/server";
import { apiWikiGate, sessionWikiGate } from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { purgeSource } from "@/lib/content-store";
import { processBlobPurgeLog } from "@/lib/blob-purge";
import { archiveSourceWithPropagation, changeSourceModelAccess } from "@/lib/model-policy";
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

/** GET /api/wikis/:id/sources/:sourceSlug — 원문 단건(본문 포함). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; sourceSlug: string }> }) {
  const { id, sourceSlug } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  return withExternalModelResponseScope(req, gate.wiki.id, async (tx) => {
    const source = await tx.source.findFirst({
      where: {
        wikiId: gate.wiki.id,
        slug: sourceSlug,
        archivedAt: null,
        ...(requestsExternalModelScope(req) ? { modelAccess: "external" as const } : {}),
      },
    });
    if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(
      {
        slug: source.slug,
        title: source.title,
        url: source.url,
        body: source.body,
        modelAccess: source.modelAccess,
        currentVersion: source.currentVersion,
        archivedAt: source.archivedAt,
        ingestedAt: source.ingestedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

/** PATCH /api/wikis/:id/sources/:sourceSlug — AI 데이터 흐름 정책 변경(editor). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; sourceSlug: string }> }) {
  const { id, sourceSlug } = await params;
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

  const source = await prisma.source.findUnique({
    where: { wikiId_slug: { wikiId: gate.wiki.id, slug: sourceSlug } },
    select: { id: true, modelAccess: true },
  });
  if (!source || (requestsExternalModelScope(req) && source.modelAccess !== "external")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const result = await changeSourceModelAccess({
      wikiId: gate.wiki.id,
      sourceId: source.id,
      expectedVersion,
      modelAccess,
      confirmExternalAccess: body.confirmExternalAccess === true,
      userId: gate.user.id,
      reason: "source policy changed through REST",
    });
    return NextResponse.json(
      {
        slug: result.source.slug,
        modelAccess: result.source.modelAccess,
        currentVersion: result.source.currentVersion,
        archivedAt: result.source.archivedAt,
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

/** 기본 DELETE는 archive, permanent=1은 owner 세션과 slug 확인 헤더가 필요한 purge다. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; sourceSlug: string }> }) {
  const { id, sourceSlug } = await params;
  const permanent = new URL(req.url).searchParams.get("permanent") === "1";

  if (permanent) {
    const gate = await sessionWikiGate(id, { minRole: "owner" });
    if (!gate.ok) return gate.res;
    const requestedVersion = optionalExpectedVersionFromRequest(req);
    if (requestedVersion.state === "invalid") {
      return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
    }
    if (!purgeConfirmationMatches(req, sourceSlug)) {
      return NextResponse.json({ error: "purge_confirmation_required" }, { status: 400 });
    }
    const source = await prisma.source.findUnique({
      where: { wikiId_slug: { wikiId: gate.wiki.id, slug: sourceSlug } },
      select: {
        id: true,
        slug: true,
        currentVersion: true,
      },
    });
    if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      const purged = await purgeSource({
        wikiId: gate.wiki.id,
        sourceId: source.id,
        expectedVersion: requestedVersion.state === "valid" ? requestedVersion.value : source.currentVersion,
      });
      const cleanup = purged.cleanupLogId
        ? await processBlobPurgeLog(purged.cleanupLogId).catch(() => ({ completed: false, remaining: purged.storageKeys.length }))
        : { completed: true, remaining: 0 };
      const blobCleanupPending = !cleanup.completed;
      return NextResponse.json(
        { deleted: true, purged: true, slug: source.slug, blobCleanupPending },
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
  const source = await prisma.source.findFirst({
    where: {
      wikiId: gate.wiki.id,
      slug: sourceSlug,
      archivedAt: null,
      ...(requestsExternalModelScope(req) ? { modelAccess: "external" as const } : {}),
    },
    select: { id: true, slug: true, currentVersion: true },
  });
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const noteSlugs = await prisma.page.findMany({
    where: { wikiId: gate.wiki.id, sourceId: source.id, kind: "note", archivedAt: null },
    select: { slug: true },
  });
  try {
    const result = await archiveSourceWithPropagation({
      wikiId: gate.wiki.id,
      sourceId: source.id,
      expectedVersion: requestedVersion.state === "valid" ? requestedVersion.value : source.currentVersion,
      userId: gate.user.id,
      reason: "source archived through REST",
    });
    return NextResponse.json(
      {
        deleted: true,
        archived: true,
        slug: source.slug,
        deletedNotes: noteSlugs.map((note) => note.slug),
        signals: result.signals,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}
