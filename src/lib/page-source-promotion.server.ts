import "server-only";
import { queueIncrementalKnowledgeBuildTx } from "@/lib/builds";
import {
  ContentNotFoundError,
  ContentProvenanceError,
  ContentVersionConflictError,
  createPageSnapshotTx,
  createSourceSnapshotTx,
} from "@/lib/content-store";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import {
  isPageSourcePromotionEligible,
  pageSourcePromotionReason,
  pageSourcePromotionRootSlug,
} from "@/lib/page-source-promotion";
import { refreshPageDerivedState, refreshSourceDerivedState } from "@/lib/page-projections";
import { isReservedSlug } from "@/lib/ontology";

export class PageSourcePromotionNotAllowedError extends Error {
  readonly code = "PAGE_SOURCE_PROMOTION_NOT_ALLOWED";

  constructor() {
    super("only active human/mixed concept, entity, or meta Pages can be promoted to a Source");
    this.name = "PageSourcePromotionNotAllowedError";
  }
}

export type PageSourcePromotionResult = {
  sourceId: string;
  sourceSlug: string;
  sourceRevisionId: string;
  notePageId: string | null;
  buildId: string | null;
  runId: string | null;
  created: boolean;
};

function sourceNoteBody(input: {
  sourceSlug: string;
  content: string;
  internalOnly: boolean;
}): string {
  if (input.internalOnly) {
    return `> 로컬 전용 사용자 원문\n> source: ${input.sourceSlug}\n> 외부 AI/OCR 처리 제외`;
  }
  return `> 사용자 작성 페이지에서 편입한 원문\n> source: ${input.sourceSlug}\n\n${input.content.slice(0, 2000)}`;
}

function firstAvailableSlug(root: string, occupied: Set<string>): string {
  for (let index = 0; index < 100; index++) {
    const candidate = index === 0 ? root : `${root}-${index + 1}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("promoted Source slug retry limit exceeded");
}

function firstAvailableNoteSlug(root: string, occupied: Set<string>): string {
  for (let index = 0; index < 100; index++) {
    const candidate = index === 0 ? root : `${root}-source${index === 1 ? "" : `-${index}`}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("promoted Source note slug retry limit exceeded");
}

/**
 * 현재 human/mixed Page content를 사용자 SourceRevision으로 명시적으로 편입한다.
 * Source, deterministic note, external incremental build를 한 policy-locked transaction에 묶어
 * 더블 클릭과 동시 제출에서도 동일 PageRevision당 하나만 생성한다.
 */
export async function promotePageSnapshotToSource(input: {
  wikiId: string;
  pageSlug: string;
  expectedVersion: number;
  userId: string;
}): Promise<PageSourcePromotionResult> {
  const result = await withModelPolicyWriteLock(input.wikiId, async (tx) => {
    const page = await tx.page.findFirst({
      where: { wikiId: input.wikiId, slug: input.pageSlug },
    });
    if (!page) throw new ContentNotFoundError("page");
    if (page.currentVersion !== input.expectedVersion) {
      throw new ContentVersionConflictError(input.expectedVersion, page.currentVersion);
    }
    if (!isPageSourcePromotionEligible({
      origin: page.origin,
      kind: page.kind,
      archivedAt: page.archivedAt,
      reserved: isReservedSlug(page.slug),
    })) {
      throw new PageSourcePromotionNotAllowedError();
    }

    const pageRevision = await tx.pageRevision.findUnique({
      where: { pageId_version: { pageId: page.id, version: page.currentVersion } },
    });
    if (!pageRevision || pageRevision.contentHash === "") {
      throw new ContentProvenanceError("current Page projection has no matching immutable revision");
    }

    const promotionReason = pageSourcePromotionReason(pageRevision.id);
    const existingRevision = await tx.sourceRevision.findFirst({
      where: { reason: promotionReason, source: { wikiId: input.wikiId } },
      orderBy: { createdAt: "asc" },
      include: { source: true },
    });

    let created = false;
    let promotedRevision = existingRevision;
    if (promotedRevision) {
      if (
        promotedRevision.title !== page.title ||
        promotedRevision.body !== page.body ||
        promotedRevision.modelAccess !== page.modelAccess
      ) {
        throw new ContentProvenanceError("Page promotion marker points at a different snapshot");
      }
    } else {
      const root = pageSourcePromotionRootSlug(page.slug, page.currentVersion, pageRevision.id);
      const occupied = new Set((await tx.source.findMany({
        where: { wikiId: input.wikiId, slug: { startsWith: root } },
        select: { slug: true },
      })).map((source) => source.slug));
      const saved = await createSourceSnapshotTx(tx, {
        wikiId: input.wikiId,
        slug: firstAvailableSlug(root, occupied),
        title: page.title,
        body: page.body,
        modelAccess: page.modelAccess,
        context: {
          actor: "human",
          userId: input.userId,
          reason: promotionReason,
        },
      });
      promotedRevision = { ...saved.revision, source: saved.source };
      created = true;
    }

    const source = promotedRevision.source;
    const currentSourceRevision = source.currentVersion === promotedRevision.version
      ? promotedRevision
      : await tx.sourceRevision.findUniqueOrThrow({
          where: { sourceId_version: { sourceId: source.id, version: source.currentVersion } },
          include: { source: true },
        });

    let note = await tx.page.findFirst({
      where: { wikiId: input.wikiId, sourceId: source.id, kind: "note", archivedAt: null },
      select: { id: true },
    });
    if (!source.archivedAt && !note) {
      const occupied = new Set((await tx.page.findMany({
        where: { wikiId: input.wikiId, slug: { startsWith: source.slug } },
        select: { slug: true },
      })).map((candidate) => candidate.slug));
      const savedNote = await createPageSnapshotTx(tx, {
        wikiId: input.wikiId,
        slug: firstAvailableNoteSlug(source.slug, occupied),
        title: source.title,
        kind: "note",
        body: sourceNoteBody({
          sourceSlug: source.slug,
          content: source.body ?? "",
          internalOnly: source.modelAccess === "internalOnly",
        }),
        sourceId: source.id,
        sourceRevisionIds: [currentSourceRevision.id],
        modelAccess: source.modelAccess,
        context: {
          actor: "agent",
          userId: input.userId,
          reason: source.modelAccess === "internalOnly"
            ? "internal promoted Page source note stub"
            : "promoted Page source note stub",
        },
      });
      note = { id: savedNote.page.id };
    }

    let queued: { runId: string; buildId: string } | null = null;
    if (!source.archivedAt && source.modelAccess === "external") {
      const existingBuild = await tx.knowledgeBuild.findFirst({
        where: {
          wikiId: input.wikiId,
          mode: "incremental",
          status: { notIn: ["failed", "cancelled"] },
          inputManifest: { path: ["sourceRevisionId"], equals: currentSourceRevision.id },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, agentRunId: true },
      });
      queued = existingBuild?.agentRunId
        ? { runId: existingBuild.agentRunId, buildId: existingBuild.id }
        : await queueIncrementalKnowledgeBuildTx(
            tx,
            input.wikiId,
            input.userId,
            currentSourceRevision.id,
          );
    }

    return {
      sourceId: source.id,
      sourceSlug: source.slug,
      sourceRevisionId: promotedRevision.id,
      notePageId: note?.id ?? null,
      buildId: queued?.buildId ?? null,
      runId: queued?.runId ?? null,
      created,
    };
  });

  await Promise.all([
    refreshSourceDerivedState(input.wikiId, result.sourceId),
    result.notePageId ? refreshPageDerivedState(input.wikiId, result.notePageId) : Promise.resolve(),
  ]);
  return result;
}
