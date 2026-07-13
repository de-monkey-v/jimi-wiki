import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { listPages, upsertPage, getSource } from "@/lib/wiki";
import { prisma } from "@/lib/db";
import { reindexEmbeddings } from "@/lib/search";
import { normalizeCategoryForWrite } from "@/lib/governance";
import { PAGE_KINDS, isAiExcludedKind } from "@/lib/kinds";
import {
  contentMutationErrorResponse,
  parseExpectedVersion,
  requestsExternalModelScope,
  withExternalModelResponseScope,
} from "@/lib/content-api";
import { normalizeSlug } from "@/lib/markdown";
import type { ModelAccess, PageKind } from "@/generated/prisma/client";
import { stageExternalPageProposal } from "@/lib/builds";
import { ONTOLOGY_PAGE_SLUG } from "@/lib/wiki-routes";
import { sanitizeCategorySlug } from "@/lib/ontology";

export const dynamic = "force-dynamic";

/** GET /api/wikis/:id/pages — 페이지 목록. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  return withExternalModelResponseScope(req, gate.wiki.id, async (tx) => {
    const pages = requestsExternalModelScope(req)
      ? await tx.page.findMany({
        where: {
          wikiId: gate.wiki.id,
          archivedAt: null,
          modelAccess: "external",
          kind: { not: "personal" },
          slug: { not: ONTOLOGY_PAGE_SLUG },
        },
        orderBy: [{ kind: "asc" }, { title: "asc" }],
        select: {
          id: true,
          slug: true,
          title: true,
          kind: true,
          category: true,
          currentVersion: true,
          updatedAt: true,
        },
      })
      : await listPages(gate.wiki.id);
    return NextResponse.json({ pages }, { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * POST /api/wikis/:id/pages — 페이지 생성/수정(raw, AI 무관).
 * body: { slug?, title, kind, body, embed? }. embed=true면 라우트 레벨에서 reindexEmbeddings 호출.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;

  let body: {
    slug?: string;
    title?: string;
    kind?: string;
    body?: string;
    embed?: boolean;
    category?: string;
    sourceSlug?: string;
    modelAccess?: ModelAccess;
    expectedVersion?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !body.title || typeof body.body !== "string") {
    return NextResponse.json({ error: "title_and_body_required" }, { status: 400 });
  }
  // kind는 명시 필수 — 생략 시 조용히 note로 떨어지면 지울 수 없는 정크 노트가 생긴다(불변 계층).
  if (body.kind === undefined) {
    return NextResponse.json({ error: "kind_required" }, { status: 400 });
  }
  // MCP write_page의 kind enum과 정합. 잘못된 kind는 거부.
  if (!PAGE_KINDS.includes(body.kind as PageKind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }
  // 개인 노트(personal)는 AI 제외 kind — 프로그램적(REST/MCP) 생성 불가, 사람이 UI로만 만든다.
  if (isAiExcludedKind(body.kind as PageKind)) {
    return NextResponse.json({ error: "personal_kind_ui_only" }, { status: 400 });
  }
  const kind = body.kind as PageKind;
  const wantedSlug = body.slug ? normalizeSlug(body.slug) : "";
  const occupied = wantedSlug
    ? await prisma.page.findUnique({
        where: { wikiId_slug: { wikiId: gate.wiki.id, slug: wantedSlug } },
        select: {
          id: true,
          slug: true,
          origin: true,
          modelAccess: true,
          archivedAt: true,
          currentVersion: true,
          category: true,
          parentId: true,
          sortOrder: true,
          revisions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { version: true, sources: { select: { sourceRevisionId: true } } },
          },
        },
      })
    : null;
  if (requestsExternalModelScope(req) && occupied?.modelAccess === "internalOnly") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (occupied?.archivedAt) {
    return NextResponse.json({ error: "archived_slug_conflict" }, { status: 409 });
  }
  const expectedVersion = occupied ? parseExpectedVersion(body.expectedVersion) : undefined;
  if (occupied && !expectedVersion) {
    return NextResponse.json({ error: "expected_version_required" }, { status: 400 });
  }
  // upsert update에서 생략은 현재 정책 유지, create에서만 확정 기본값 external을 적용한다.
  const modelAccess = body.modelAccess ?? occupied?.modelAccess ?? "external";
  if (modelAccess !== "external" && modelAccess !== "internalOnly") {
    return NextResponse.json({ error: "invalid_model_access" }, { status: 400 });
  }
  if (occupied && body.modelAccess !== undefined && body.modelAccess !== occupied.modelAccess) {
    return NextResponse.json({ error: "use_page_policy_patch" }, { status: 409 });
  }
  // S3: raw REST 경로도 거버넌스 우회 못 하게 서버측 정규화. note는 순수성 위해 category 없음.
  const category = kind === "note"
    ? null
    : body.category
      ? requestsExternalModelScope(req)
        // raw ontology label/synonym은 internalOnly 문서에서 유래했을 수 있다. 외부 agent
        // write는 자신이 보낸 slug만 결정론적으로 정규화하고 ontology projection을 읽지 않는다.
        ? sanitizeCategorySlug(String(body.category))
        : await normalizeCategoryForWrite(gate.wiki.id, String(body.category))
      : undefined;

  // 외부(AI 무관) ingest의 provenance: note는 sourceId 연결, 파생 페이지는 기여(PageContribution) 기록
  let source: Awaited<ReturnType<typeof getSource>> = null;
  if (body.sourceSlug) {
    source = await getSource(gate.wiki.id, String(body.sourceSlug));
    if (
      !source ||
      source.archivedAt ||
      (requestsExternalModelScope(req) && source.modelAccess !== "external")
    ) {
      return NextResponse.json({ error: "source_not_found" }, { status: 400 });
    }
  }
  // note는 반드시 원문(sourceSlug)에 연결한다 — 출처 없는 정크 노트를 원천 차단.
  if (kind === "note" && !source) {
    return NextResponse.json({ error: "note_requires_source" }, { status: 400 });
  }
  const sourceRevision = source
    ? await prisma.sourceRevision.findUnique({
        where: { sourceId_version: { sourceId: source.id, version: source.currentVersion } },
        select: { id: true, version: true, contentHash: true },
      })
    : null;
  if (source && !sourceRevision) {
    return NextResponse.json({ error: "source_revision_not_found" }, { status: 409 });
  }

  const occupiedRevision = occupied?.revisions[0];
  const inheritedSourceRevisionIds = occupied && occupiedRevision?.version === occupied.currentVersion
    ? occupiedRevision.sources.map((entry) => entry.sourceRevisionId)
    : [];
  const sourceRevisionIds = kind === "note"
    ? (sourceRevision ? [sourceRevision.id] : [])
    : [...new Set([...inheritedSourceRevisionIds, ...(sourceRevision ? [sourceRevision.id] : [])])];

  // MCP/외부 agent가 human/mixed Page를 직접 덮지 못하게 Page 대신 review draft를 만든다.
  if (
    requestsExternalModelScope(req) &&
    occupied &&
    (occupied.origin === "human" || occupied.origin === "mixed")
  ) {
    if (kind === "meta") {
      return NextResponse.json({ error: "external_agent_meta_conflict" }, { status: 409 });
    }
    try {
      const staged = await stageExternalPageProposal({
        wikiId: gate.wiki.id,
        userId: gate.user.id,
        page: {
          id: occupied.id,
          slug: occupied.slug,
          currentVersion: occupied.currentVersion,
          parentId: occupied.parentId,
          sortOrder: occupied.sortOrder,
          modelAccess: occupied.modelAccess,
        },
        title: String(body.title),
        body: body.body,
        kind: kind as "note" | "concept" | "entity",
        category: category === undefined ? occupied.category : category,
        sourceRevisionIds,
        ...(source && sourceRevision ? {
          buildInput: {
            sourceId: source.id,
            sourceSlug: source.slug,
            sourceRevisionId: sourceRevision.id,
            version: source.currentVersion,
            policyVersion: source.policyVersion,
            contentHash: sourceRevision.contentHash,
          },
        } : {}),
      });
      return NextResponse.json(
        { created: false, staged: true, conflict: true, slug: occupied.slug, ...staged },
        { status: 202 },
      );
    } catch (error) {
      return contentMutationErrorResponse(error);
    }
  }

  try {
    const res = await upsertPage(gate.wiki.id, {
      slug: body.slug,
      title: String(body.title),
      kind,
      body: body.body,
      category,
      modelAccess,
      userId: gate.user.id,
      actor: requestsExternalModelScope(req) ? "agent" : "human",
      reason: "page written through REST",
      expectedVersion: expectedVersion ?? undefined,
      sourceRevisionIds,
      ...(source && kind === "note" ? { sourceId: source.id } : {}),
    });

    let embedded = 0;
    if (body.embed) ({ embedded } = await reindexEmbeddings(gate.wiki.id));

    const page = await prisma.page.findUniqueOrThrow({
      where: { wikiId_slug: { wikiId: gate.wiki.id, slug: res.slug } },
      select: { origin: true, modelAccess: true, currentVersion: true, archivedAt: true },
    });
    return NextResponse.json({ ...res, ...page, embedded }, { status: res.created ? 201 : 200 });
  } catch (error) {
    return contentMutationErrorResponse(error);
  }
}
