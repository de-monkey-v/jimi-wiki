import "server-only";
import { prisma } from "@/lib/db";
import { pageSnapshotHash, sourceSnapshotHash } from "@/lib/content-hash";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import { BLOB_PURGE_PENDING_TITLE, blobPurgePayload } from "@/lib/blob-purge";
import {
  isAgentWriteConflict,
  isPolicyRelaxation,
  modelAccessForKind,
  modelAccessForRestore,
  originForCreate,
  stricterModelAccess,
  transitionPageOrigin,
} from "@/lib/content-policy";
import type {
  DocumentType,
  ModelAccess,
  Page,
  PageKind,
  PageOrigin,
  PageRevision,
  RevisionActor,
  Source,
  SourceCurationState,
  SourceRevision,
} from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

export type ContentTransaction = Prisma.TransactionClient;

export interface RevisionContext {
  actor: RevisionActor;
  reason?: string | null;
  userId?: string | null;
  agentRunId?: string | null;
  buildId?: string | null;
}

export class ContentNotFoundError extends Error {
  readonly code = "CONTENT_NOT_FOUND";

  constructor(resource: "page" | "source" | "revision") {
    super(`${resource} not found`);
    this.name = "ContentNotFoundError";
  }
}

export class ContentVersionConflictError extends Error {
  readonly code = "CONTENT_VERSION_CONFLICT";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion?: number,
  ) {
    super(`content version conflict: expected ${expectedVersion}${actualVersion === undefined ? "" : `, actual ${actualVersion}`}`);
    this.name = "ContentVersionConflictError";
  }
}

export class ContentOriginConflictError extends Error {
  readonly code = "HUMAN_PAGE_CONFLICT";

  constructor(readonly origin: PageOrigin) {
    super(`agent write requires a review draft for ${origin} content`);
    this.name = "ContentOriginConflictError";
  }
}

export class ContentPolicyRelaxationError extends Error {
  readonly code = "POLICY_RELAXATION_REQUIRES_CONFIRMATION";

  constructor() {
    super("internalOnly content requires explicit confirmation before external model access can be enabled");
    this.name = "ContentPolicyRelaxationError";
  }
}

export class ContentProvenanceError extends Error {
  readonly code = "INVALID_REVISION_PROVENANCE";

  constructor(message: string) {
    super(message);
    this.name = "ContentProvenanceError";
  }
}

/**
 * 휴지통 시각은 archive revision과 별개의 복구 보존기간 메타데이터다. Page/Source projection
 * direct write 경계는 유지하되, 콘텐츠 snapshot hash/revision에는 포함하지 않는다.
 */
export async function setPageTrashStateTx(
  tx: ContentTransaction,
  input: {
    wikiId: string;
    pageId: string;
    trashedAt: Date | null;
    purgeAt: Date | null;
    archivedBeforeTrash: boolean;
  },
) {
  const updated = await tx.page.updateMany({
    where: { id: input.pageId, wikiId: input.wikiId },
    data: {
      trashedAt: input.trashedAt,
      purgeAt: input.purgeAt,
      archivedBeforeTrash: input.archivedBeforeTrash,
    },
  });
  if (updated.count !== 1) throw new ContentNotFoundError("page");
  return tx.page.findUniqueOrThrow({ where: { id: input.pageId } });
}

export async function setSourceTrashStateTx(
  tx: ContentTransaction,
  input: {
    wikiId: string;
    sourceId: string;
    trashedAt: Date | null;
    purgeAt: Date | null;
    archivedBeforeTrash: boolean;
  },
) {
  const updated = await tx.source.updateMany({
    where: { id: input.sourceId, wikiId: input.wikiId },
    data: {
      trashedAt: input.trashedAt,
      purgeAt: input.purgeAt,
      archivedBeforeTrash: input.archivedBeforeTrash,
    },
  });
  if (updated.count !== 1) throw new ContentNotFoundError("source");
  return tx.source.findUniqueOrThrow({ where: { id: input.sourceId } });
}

export interface SnapshotWriteResult<TProjection, TRevision> {
  projection: TProjection;
  revision: TRevision;
}

export interface PageSnapshotWriteResult extends SnapshotWriteResult<Page, PageRevision> {
  page: Page;
}

export interface SourceSnapshotWriteResult extends SnapshotWriteResult<Source, SourceRevision> {
  source: Source;
}

interface PageState {
  title: string;
  body: string;
  kind: PageKind;
  frontmatter: Prisma.InputJsonValue;
  category: string | null;
  documentType: DocumentType | null;
  documentAt: Date | null;
  parentId: string | null;
  sortOrder: number;
  sourceId: string | null;
  origin: PageOrigin;
  modelAccess: ModelAccess;
  archivedAt: Date | null;
  suppressedAt: Date | null;
  staleAt: Date | null;
}

export interface CreatePageSnapshotInput {
  wikiId: string;
  slug: string;
  title: string;
  body?: string;
  kind: PageKind;
  frontmatter?: Prisma.InputJsonValue;
  category?: string | null;
  documentType?: DocumentType | null;
  documentAt?: Date | null;
  parentId?: string | null;
  sortOrder?: number;
  sourceId?: string | null;
  origin?: PageOrigin;
  modelAccess?: ModelAccess;
  archivedAt?: Date | null;
  suppressedAt?: Date | null;
  staleAt?: Date | null;
  sourceRevisionIds?: string[];
  context: RevisionContext;
}

export interface PageSnapshotChanges {
  title?: string;
  body?: string;
  kind?: PageKind;
  frontmatter?: Prisma.InputJsonValue;
  category?: string | null;
  documentType?: DocumentType | null;
  documentAt?: Date | null;
  parentId?: string | null;
  sortOrder?: number;
  sourceId?: string | null;
  origin?: PageOrigin;
  modelAccess?: ModelAccess;
  archivedAt?: Date | null;
  suppressedAt?: Date | null;
  staleAt?: Date | null;
}

export interface UpdatePageSnapshotInput {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  changes: PageSnapshotChanges;
  /** undefined면 직전 revision의 provenance를 그대로 승계한다. */
  sourceRevisionIds?: string[];
  acceptedAiDraft?: boolean;
  allowPolicyRelaxation?: boolean;
  /** lifecycle/policy metadata write와 전체 build restore에서 저작 origin을 보존한다. */
  preserveOriginOnRestore?: boolean;
  context: RevisionContext;
}

interface ResolvedSourceRevision {
  id: string;
  sourceId: string;
  modelAccess: ModelAccess;
  revisionArchivedAt: Date | null;
  sourceArchivedAt: Date | null;
}

const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const unique = (values: string[] | undefined) => [...new Set((values ?? []).filter(Boolean))];

async function assertParent(tx: ContentTransaction, wikiId: string, pageId: string | null): Promise<void> {
  if (!pageId) return;
  const parent = await tx.page.findFirst({ where: { id: pageId, wikiId }, select: { id: true } });
  if (!parent) throw new ContentProvenanceError("parent page must belong to the same wiki");
}

async function resolveSourceRevisions(
  tx: ContentTransaction,
  wikiId: string,
  sourceRevisionIds: string[],
): Promise<ResolvedSourceRevision[]> {
  if (sourceRevisionIds.length === 0) return [];
  const rows = await tx.sourceRevision.findMany({
    where: { id: { in: sourceRevisionIds }, source: { wikiId } },
    select: {
      id: true,
      sourceId: true,
      modelAccess: true,
      archivedAt: true,
      source: { select: { modelAccess: true, archivedAt: true } },
    },
  });
  if (rows.length !== sourceRevisionIds.length) {
    throw new ContentProvenanceError("every SourceRevision must exist in the same wiki");
  }
  const byId = new Map(rows.map((row) => [row.id, {
    id: row.id,
    sourceId: row.sourceId,
    modelAccess: stricterModelAccess(row.modelAccess, row.source.modelAccess),
    revisionArchivedAt: row.archivedAt,
    sourceArchivedAt: row.source.archivedAt,
  }]));
  return sourceRevisionIds.map((id) => byId.get(id)!);
}

function assertActivePageSourceEligibility(
  archivedAt: Date | null,
  resolved: ResolvedSourceRevision[],
  previous?: { revisionIds: Set<string>; sourceIds: Set<string> },
): void {
  if (archivedAt) return;
  for (const revision of resolved) {
    // Source archive propagation은 이미 연결돼 있던 Source를 새 archived revision으로 전진시켜
    // active generated Page를 stale 처리할 수 있다. 새 archived Source 연결만 금지한다.
    if (revision.sourceArchivedAt && !previous?.sourceIds.has(revision.sourceId)) {
      throw new ContentProvenanceError("active Page cannot attach a newly archived Source");
    }
    // Source가 다시 active여도 과거 archived revision을 새 provenance로 붙일 수 없다.
    if (
      !revision.sourceArchivedAt &&
      revision.revisionArchivedAt &&
      !previous?.revisionIds.has(revision.id)
    ) {
      throw new ContentProvenanceError("active Page cannot attach an archived SourceRevision");
    }
  }
}

function primarySourceId(
  kind: PageKind,
  requested: string | null | undefined,
  resolved: ResolvedSourceRevision[],
): string | null {
  if (requested !== undefined) {
    if (requested !== null && !resolved.some((revision) => revision.sourceId === requested)) {
      throw new ContentProvenanceError("Page.sourceId must be represented by an exact SourceRevision");
    }
    return requested;
  }
  if (kind === "note" && resolved.length > 0) return resolved[0].sourceId;
  return null;
}

function assertDocumentPageState(state: Pick<PageState, "kind" | "documentType" | "documentAt" | "sourceId">, sourceRevisionIds: string[]): void {
  if (state.kind === "document") {
    if (!state.documentType || !state.documentAt) {
      throw new ContentProvenanceError("document pages require documentType and documentAt");
    }
    if (state.sourceId || sourceRevisionIds.length > 0) {
      throw new ContentProvenanceError("document pages cannot attach Source provenance");
    }
    return;
  }
  if (state.documentType || state.documentAt) {
    throw new ContentProvenanceError("document metadata is only valid for document pages");
  }
}

function revisionData(state: PageState, pageId: string, version: number, context: RevisionContext) {
  return {
    pageId,
    version,
    title: state.title,
    body: state.body,
    kind: state.kind,
    frontmatter: state.frontmatter,
    category: state.category,
    documentType: state.documentType,
    documentAt: state.documentAt,
    parentId: state.parentId,
    sortOrder: state.sortOrder,
    sourceId: state.sourceId,
    origin: state.origin,
    modelAccess: state.modelAccess,
    archivedAt: state.archivedAt,
    suppressedAt: state.suppressedAt,
    staleAt: state.staleAt,
    contentHash: pageSnapshotHash(state),
    actor: context.actor,
    reason: context.reason ?? null,
    userId: context.userId ?? null,
    agentRunId: context.agentRunId ?? null,
    buildId: context.buildId ?? null,
  } satisfies Prisma.PageRevisionUncheckedCreateInput;
}

async function attachRevisionSources(
  tx: ContentTransaction,
  pageRevisionId: string,
  sourceRevisionIds: string[],
): Promise<void> {
  if (sourceRevisionIds.length === 0) return;
  await tx.pageRevisionSource.createMany({
    data: sourceRevisionIds.map((sourceRevisionId) => ({ pageRevisionId, sourceRevisionId })),
    skipDuplicates: true,
  });
}

/**
 * projection policy/lifecycle commit과 SearchChunk의 민감 경계를 같은 transaction에 묶는다.
 * 본문/링크 등 파생 projection은 post-commit 재생성이 가능하지만, external vector 잔존은
 * crash 뒤에도 허용할 수 없으므로 여기서 fail-closed로 먼저 제거한다.
 */
async function syncContentSearchPolicyTx(
  tx: ContentTransaction,
  input: {
    wikiId: string;
    refType: "page" | "source";
    refId: string;
    modelAccess: ModelAccess;
    archivedAt: Date | null;
  },
): Promise<void> {
  if (input.archivedAt) {
    await tx.searchChunk.deleteMany({
      where: { wikiId: input.wikiId, refType: input.refType, refId: input.refId },
    });
    return;
  }
  if (input.modelAccess === "internalOnly") {
    await tx.$executeRawUnsafe(
      `UPDATE "SearchChunk" SET embedding = NULL WHERE "wikiId"=$1 AND "refType"=$2 AND "refId"=$3`,
      input.wikiId,
      input.refType,
      input.refId,
    );
  }
  await tx.searchChunk.updateMany({
    where: { wikiId: input.wikiId, refType: input.refType, refId: input.refId },
    data: { modelAccess: input.modelAccess },
  });
}

export async function createPageSnapshotTx(
  tx: ContentTransaction,
  input: CreatePageSnapshotInput,
): Promise<PageSnapshotWriteResult> {
  const sourceRevisionIds = unique(input.sourceRevisionIds);
  const sourceRevisions = await resolveSourceRevisions(tx, input.wikiId, sourceRevisionIds);
  await assertParent(tx, input.wikiId, input.parentId ?? null);

  const kind = input.kind;
  const requestedAccess = modelAccessForKind(kind, input.modelAccess ?? "external");
  const state: PageState = {
    title: input.title,
    body: input.body ?? "",
    kind,
    frontmatter: input.frontmatter ?? {},
    category: input.category ?? null,
    documentType: input.documentType ?? null,
    documentAt: input.documentAt ?? null,
    parentId: input.parentId ?? null,
    sortOrder: input.sortOrder ?? 0,
    sourceId: primarySourceId(kind, input.sourceId, sourceRevisions),
    origin: originForCreate(input.context.actor, input.origin),
    modelAccess: stricterModelAccess(requestedAccess, ...sourceRevisions.map((revision) => revision.modelAccess)),
    archivedAt: input.archivedAt ?? null,
    suppressedAt: input.suppressedAt ?? null,
    staleAt: input.staleAt ?? null,
  };
  assertDocumentPageState(state, sourceRevisionIds);
  assertActivePageSourceEligibility(state.archivedAt, sourceRevisions);

  const projection = await tx.page.create({
    data: {
      wikiId: input.wikiId,
      slug: input.slug,
      ...state,
      currentVersion: 1,
      policyVersion: 1,
    },
  });
  const revision = await tx.pageRevision.create({ data: revisionData(state, projection.id, 1, input.context) });
  await attachRevisionSources(tx, revision.id, sourceRevisionIds);
  return { page: projection, projection, revision };
}

export function createPageSnapshot(input: CreatePageSnapshotInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => createPageSnapshotTx(tx, input));
}

async function inheritedPageSources(
  tx: ContentTransaction,
  pageId: string,
  version: number,
): Promise<{ revisionIds: string[]; sourceIds: Set<string> }> {
  const previous = await tx.pageRevision.findUnique({
    where: { pageId_version: { pageId, version } },
    select: {
      sources: {
        select: { sourceRevisionId: true, sourceRevision: { select: { sourceId: true } } },
      },
    },
  });
  return {
    revisionIds: previous?.sources.map((source) => source.sourceRevisionId) ?? [],
    sourceIds: new Set(previous?.sources.map((source) => source.sourceRevision.sourceId) ?? []),
  };
}

export async function updatePageSnapshotTx(
  tx: ContentTransaction,
  input: UpdatePageSnapshotInput,
): Promise<PageSnapshotWriteResult> {
  const current = await tx.page.findFirst({ where: { id: input.pageId, wikiId: input.wikiId } });
  if (!current) throw new ContentNotFoundError("page");
  if (current.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, current.currentVersion);
  }
  if (isAgentWriteConflict(current.origin, input.context.actor, input.acceptedAiDraft)) {
    throw new ContentOriginConflictError(current.origin);
  }

  const inheritedSources = await inheritedPageSources(tx, current.id, current.currentVersion);
  const sourceRevisionIds = unique(input.sourceRevisionIds ?? inheritedSources.revisionIds);
  const sourceRevisions = await resolveSourceRevisions(tx, input.wikiId, sourceRevisionIds);
  const kind = input.changes.kind ?? current.kind;
  if (kind !== current.kind && (kind === "document" || current.kind === "document")) {
    throw new ContentProvenanceError("document pages cannot be converted to or from another page kind");
  }
  const parentId = own(input.changes, "parentId") ? (input.changes.parentId ?? null) : current.parentId;
  await assertParent(tx, input.wikiId, parentId);
  if (parentId === current.id) throw new ContentProvenanceError("a page cannot be its own parent");

  let requestedAccess = input.changes.modelAccess ?? current.modelAccess;
  if (input.context.actor === "restore") {
    requestedAccess = modelAccessForRestore(current.modelAccess, requestedAccess, kind);
  } else {
    requestedAccess = modelAccessForKind(kind, requestedAccess);
    if (isPolicyRelaxation(current.modelAccess, requestedAccess) && !input.allowPolicyRelaxation) {
      throw new ContentPolicyRelaxationError();
    }
  }
  const modelAccess = stricterModelAccess(requestedAccess, ...sourceRevisions.map((revision) => revision.modelAccess));
  const sourceId = own(input.changes, "sourceId")
    ? primarySourceId(kind, input.changes.sourceId, sourceRevisions)
    : input.sourceRevisionIds !== undefined && kind === "note"
      ? primarySourceId(kind, undefined, sourceRevisions)
      : current.sourceId ?? primarySourceId(kind, undefined, sourceRevisions);
  const archivedAt = own(input.changes, "archivedAt") ? (input.changes.archivedAt ?? null) : current.archivedAt;
  assertActivePageSourceEligibility(archivedAt, sourceRevisions, {
    revisionIds: new Set(inheritedSources.revisionIds),
    sourceIds: inheritedSources.sourceIds,
  });
  const state: PageState = {
    title: input.changes.title ?? current.title,
    body: input.changes.body ?? current.body,
    kind,
    frontmatter: input.changes.frontmatter ?? (current.frontmatter as Prisma.InputJsonValue),
    category: own(input.changes, "category") ? (input.changes.category ?? null) : current.category,
    documentType: own(input.changes, "documentType") ? (input.changes.documentType ?? null) : current.documentType,
    documentAt: own(input.changes, "documentAt") ? (input.changes.documentAt ?? null) : current.documentAt,
    parentId,
    sortOrder: input.changes.sortOrder ?? current.sortOrder,
    sourceId,
    origin:
      input.preserveOriginOnRestore
        ? input.changes.origin ?? current.origin
        : transitionPageOrigin(current.origin, input.context.actor, {
            acceptedAiDraft: input.acceptedAiDraft,
            requested: input.changes.origin,
          }),
    modelAccess,
    archivedAt,
    suppressedAt: own(input.changes, "suppressedAt") ? (input.changes.suppressedAt ?? null) : current.suppressedAt,
    staleAt: own(input.changes, "staleAt") ? (input.changes.staleAt ?? null) : current.staleAt,
  };
  assertDocumentPageState(state, sourceRevisionIds);
  const version = current.currentVersion + 1;
  const policyVersion = current.policyVersion + (state.modelAccess === current.modelAccess ? 0 : 1);
  const changed = await tx.page.updateMany({
    where: { id: current.id, wikiId: input.wikiId, currentVersion: input.expectedVersion },
    data: { ...state, currentVersion: version, policyVersion },
  });
  if (changed.count !== 1) throw new ContentVersionConflictError(input.expectedVersion);

  await syncContentSearchPolicyTx(tx, {
    wikiId: input.wikiId,
    refType: "page",
    refId: current.id,
    modelAccess: state.modelAccess,
    archivedAt: state.archivedAt,
  });

  const revision = await tx.pageRevision.create({ data: revisionData(state, current.id, version, input.context) });
  await attachRevisionSources(tx, revision.id, sourceRevisionIds);
  const projection = await tx.page.findUniqueOrThrow({ where: { id: current.id } });
  return { page: projection, projection, revision };
}

export function updatePageSnapshot(input: UpdatePageSnapshotInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => updatePageSnapshotTx(tx, input));
}

export interface ArchivePageSnapshotInput {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  archivedAt?: Date;
  /** true(기본)=사용자 suppression, false=build/source lifecycle archive. */
  suppression?: boolean;
  context: RevisionContext;
}

export function archivePageSnapshotTx(tx: ContentTransaction, input: ArchivePageSnapshotInput) {
  const archivedAt = input.archivedAt ?? new Date();
  return updatePageSnapshotTx(tx, {
    wikiId: input.wikiId,
    pageId: input.pageId,
    expectedVersion: input.expectedVersion,
    changes: {
      archivedAt,
      ...(input.suppression === false ? {} : { suppressedAt: archivedAt }),
    },
    preserveOriginOnRestore: true,
    context: input.context,
  });
}

export function archivePageSnapshot(input: ArchivePageSnapshotInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => archivePageSnapshotTx(tx, input));
}

export interface RestorePageRevisionInput {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  revisionId: string;
  preserveOrigin?: boolean;
  context: Omit<RevisionContext, "actor"> & { actor?: "restore" };
}

export async function restorePageRevisionTx(tx: ContentTransaction, input: RestorePageRevisionInput) {
  const selected = await tx.pageRevision.findFirst({
    where: { id: input.revisionId, pageId: input.pageId, page: { wikiId: input.wikiId } },
    select: {
      title: true,
      body: true,
      kind: true,
      frontmatter: true,
      category: true,
      documentType: true,
      documentAt: true,
      parentId: true,
      sortOrder: true,
      sourceId: true,
      origin: true,
      modelAccess: true,
      archivedAt: true,
      suppressedAt: true,
      staleAt: true,
      sources: { select: { sourceRevisionId: true } },
    },
  });
  if (!selected) throw new ContentNotFoundError("revision");
  if (!selected.archivedAt && selected.sources.length) {
    const activeSourceCount = await tx.sourceRevision.count({
      where: {
        id: { in: selected.sources.map((source) => source.sourceRevisionId) },
        source: { wikiId: input.wikiId, archivedAt: null },
      },
    });
    if (activeSourceCount !== selected.sources.length) {
      throw new Error("cannot restore an active Page whose provenance Source is archived or purged");
    }
  }
  return updatePageSnapshotTx(tx, {
    wikiId: input.wikiId,
    pageId: input.pageId,
    expectedVersion: input.expectedVersion,
    changes: {
      title: selected.title,
      body: selected.body,
      kind: selected.kind,
      frontmatter: selected.frontmatter as Prisma.InputJsonValue,
      category: selected.category,
      documentType: selected.documentType,
      documentAt: selected.documentAt,
      parentId: selected.parentId,
      sortOrder: selected.sortOrder,
      sourceId: selected.sourceId,
      origin: selected.origin,
      modelAccess: selected.modelAccess,
      archivedAt: selected.archivedAt,
      suppressedAt: selected.suppressedAt,
      staleAt: selected.staleAt,
    },
    sourceRevisionIds: selected.sources.map((source) => source.sourceRevisionId),
    acceptedAiDraft: true,
    preserveOriginOnRestore: input.preserveOrigin === true,
    context: { ...input.context, actor: "restore" },
  });
}

export function restorePageRevision(input: RestorePageRevisionInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => restorePageRevisionTx(tx, input));
}

export interface RestoreArchivedPageInput {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
  context: Omit<RevisionContext, "actor"> & { actor?: "restore" };
}

export async function restoreArchivedPageTx(tx: ContentTransaction, input: RestoreArchivedPageInput) {
  const current = await tx.page.findFirst({
    where: { id: input.pageId, wikiId: input.wikiId },
    select: {
      currentVersion: true,
      revisions: {
        where: { version: input.expectedVersion },
        take: 1,
        select: { sources: { select: { sourceRevisionId: true } } },
      },
    },
  });
  const sourceRevisionIds = current?.revisions[0]?.sources.map((source) => source.sourceRevisionId) ?? [];
  if (sourceRevisionIds.length) {
    const activeSourceCount = await tx.sourceRevision.count({
      where: {
        id: { in: sourceRevisionIds },
        source: { wikiId: input.wikiId, archivedAt: null },
      },
    });
    if (activeSourceCount !== sourceRevisionIds.length) {
      throw new Error("cannot restore a Page whose provenance Source is archived or purged");
    }
  }
  return updatePageSnapshotTx(tx, {
    wikiId: input.wikiId,
    pageId: input.pageId,
    expectedVersion: input.expectedVersion,
    changes: { archivedAt: null, suppressedAt: null },
    acceptedAiDraft: true,
    preserveOriginOnRestore: true,
    context: { ...input.context, actor: "restore" },
  });
}

export function restoreArchivedPage(input: RestoreArchivedPageInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => restoreArchivedPageTx(tx, input));
}

interface SourceState {
  title: string;
  url: string | null;
  body: string | null;
  storageKey: string | null;
  modelAccess: ModelAccess;
  archivedAt: Date | null;
}

export interface CreateSourceSnapshotInput {
  wikiId: string;
  slug: string;
  title: string;
  url?: string | null;
  body?: string | null;
  storageKey?: string | null;
  modelAccess?: ModelAccess;
  curationState?: SourceCurationState;
  archivedAt?: Date | null;
  context: RevisionContext;
}

export interface SourceSnapshotChanges {
  title?: string;
  url?: string | null;
  body?: string | null;
  storageKey?: string | null;
  modelAccess?: ModelAccess;
  archivedAt?: Date | null;
}

export interface UpdateSourceSnapshotInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  changes: SourceSnapshotChanges;
  allowPolicyRelaxation?: boolean;
  context: RevisionContext;
}

function sourceRevisionData(state: SourceState, sourceId: string, version: number, context: RevisionContext) {
  return {
    sourceId,
    version,
    ...state,
    contentHash: sourceSnapshotHash(state),
    actor: context.actor,
    reason: context.reason ?? null,
    userId: context.userId ?? null,
    agentRunId: context.agentRunId ?? null,
    buildId: context.buildId ?? null,
  } satisfies Prisma.SourceRevisionUncheckedCreateInput;
}

export async function createSourceSnapshotTx(
  tx: ContentTransaction,
  input: CreateSourceSnapshotInput,
): Promise<SourceSnapshotWriteResult> {
  const state: SourceState = {
    title: input.title,
    url: input.url ?? null,
    body: input.body ?? null,
    storageKey: input.storageKey ?? null,
    modelAccess: input.modelAccess ?? "external",
    archivedAt: input.archivedAt ?? null,
  };
  const projection = await tx.source.create({
    data: {
      wikiId: input.wikiId,
      slug: input.slug,
      ...state,
      curationState: input.curationState ?? "curated",
      currentVersion: 1,
      policyVersion: 1,
    },
  });
  const revision = await tx.sourceRevision.create({ data: sourceRevisionData(state, projection.id, 1, input.context) });
  return { source: projection, projection, revision };
}

export function createSourceSnapshot(input: CreateSourceSnapshotInput) {
  return prisma.$transaction((tx) => createSourceSnapshotTx(tx, input));
}

export interface TransitionSourceCurationInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  to: SourceCurationState;
}

/**
 * Curation is a one-way lifecycle flag, not a mutable SourceRevision payload.
 * Call this inside the same transaction that publishes curated knowledge so a
 * failed publish leaves the immutable Source in `preserved` state.
 */
export async function transitionSourceCurationStateTx(
  tx: ContentTransaction,
  input: TransitionSourceCurationInput,
): Promise<Source> {
  const current = await tx.source.findFirst({ where: { id: input.sourceId, wikiId: input.wikiId } });
  if (!current) throw new ContentNotFoundError("source");
  if (current.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, current.currentVersion);
  }
  if (current.curationState === input.to) return current;
  if (current.curationState !== "preserved" || input.to !== "curated") {
    throw new ContentProvenanceError(`invalid Source curation transition: ${current.curationState} -> ${input.to}`);
  }
  const changed = await tx.source.updateMany({
    where: {
      id: current.id,
      wikiId: input.wikiId,
      currentVersion: input.expectedVersion,
      curationState: "preserved",
    },
    data: { curationState: "curated" },
  });
  if (changed.count !== 1) throw new ContentVersionConflictError(input.expectedVersion);
  return tx.source.findUniqueOrThrow({ where: { id: current.id } });
}

export async function updateSourceSnapshotTx(
  tx: ContentTransaction,
  input: UpdateSourceSnapshotInput,
): Promise<SourceSnapshotWriteResult> {
  const current = await tx.source.findFirst({ where: { id: input.sourceId, wikiId: input.wikiId } });
  if (!current) throw new ContentNotFoundError("source");
  if (current.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, current.currentVersion);
  }

  let modelAccess = input.changes.modelAccess ?? current.modelAccess;
  if (input.context.actor === "restore") {
    modelAccess = stricterModelAccess(current.modelAccess, modelAccess);
  } else if (isPolicyRelaxation(current.modelAccess, modelAccess) && !input.allowPolicyRelaxation) {
    throw new ContentPolicyRelaxationError();
  }
  const state: SourceState = {
    title: input.changes.title ?? current.title,
    url: own(input.changes, "url") ? (input.changes.url ?? null) : current.url,
    body: own(input.changes, "body") ? (input.changes.body ?? null) : current.body,
    storageKey: own(input.changes, "storageKey") ? (input.changes.storageKey ?? null) : current.storageKey,
    modelAccess,
    archivedAt: own(input.changes, "archivedAt") ? (input.changes.archivedAt ?? null) : current.archivedAt,
  };
  const version = current.currentVersion + 1;
  const policyVersion = current.policyVersion + (state.modelAccess === current.modelAccess ? 0 : 1);
  const changed = await tx.source.updateMany({
    where: { id: current.id, wikiId: input.wikiId, currentVersion: input.expectedVersion },
    data: { ...state, currentVersion: version, policyVersion },
  });
  if (changed.count !== 1) throw new ContentVersionConflictError(input.expectedVersion);
  await syncContentSearchPolicyTx(tx, {
    wikiId: input.wikiId,
    refType: "source",
    refId: current.id,
    modelAccess: state.modelAccess,
    archivedAt: state.archivedAt,
  });
  const revision = await tx.sourceRevision.create({ data: sourceRevisionData(state, current.id, version, input.context) });
  const projection = await tx.source.findUniqueOrThrow({ where: { id: current.id } });
  return { source: projection, projection, revision };
}

export function updateSourceSnapshot(input: UpdateSourceSnapshotInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => updateSourceSnapshotTx(tx, input));
}

export interface ArchiveSourceSnapshotInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  archivedAt?: Date;
  context: RevisionContext;
}

export function archiveSourceSnapshotTx(tx: ContentTransaction, input: ArchiveSourceSnapshotInput) {
  return updateSourceSnapshotTx(tx, {
    wikiId: input.wikiId,
    sourceId: input.sourceId,
    expectedVersion: input.expectedVersion,
    changes: { archivedAt: input.archivedAt ?? new Date() },
    context: input.context,
  });
}

export function archiveSourceSnapshot(input: ArchiveSourceSnapshotInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => archiveSourceSnapshotTx(tx, input));
}

export interface RestoreSourceRevisionInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  revisionId: string;
  context: Omit<RevisionContext, "actor"> & { actor?: "restore" };
}

export async function restoreSourceRevisionTx(tx: ContentTransaction, input: RestoreSourceRevisionInput) {
  const selected = await tx.sourceRevision.findFirst({
    where: { id: input.revisionId, sourceId: input.sourceId, source: { wikiId: input.wikiId } },
  });
  if (!selected) throw new ContentNotFoundError("revision");
  return updateSourceSnapshotTx(tx, {
    wikiId: input.wikiId,
    sourceId: input.sourceId,
    expectedVersion: input.expectedVersion,
    changes: {
      title: selected.title,
      url: selected.url,
      body: selected.body,
      storageKey: selected.storageKey,
      modelAccess: selected.modelAccess,
      archivedAt: selected.archivedAt,
    },
    context: { ...input.context, actor: "restore" },
  });
}

export function restoreSourceRevision(input: RestoreSourceRevisionInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => restoreSourceRevisionTx(tx, input));
}

export interface RestoreArchivedSourceInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
  context: Omit<RevisionContext, "actor"> & { actor?: "restore" };
}

export function restoreArchivedSourceTx(tx: ContentTransaction, input: RestoreArchivedSourceInput) {
  return updateSourceSnapshotTx(tx, {
    wikiId: input.wikiId,
    sourceId: input.sourceId,
    expectedVersion: input.expectedVersion,
    changes: { archivedAt: null },
    context: { ...input.context, actor: "restore" },
  });
}

export function restoreArchivedSource(input: RestoreArchivedSourceInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => restoreArchivedSourceTx(tx, input));
}

async function markBuildsUnrestorable(
  tx: ContentTransaction,
  wikiId: string,
  buildIds: string[],
  reason: string,
): Promise<void> {
  const ids = unique(buildIds);
  if (ids.length === 0) return;
  await tx.knowledgeBuild.updateMany({
    where: { wikiId, id: { in: ids } },
    data: { restorable: false, unrestorableReason: reason },
  });
}

export interface PurgePageInput {
  wikiId: string;
  pageId: string;
  expectedVersion: number;
}

export async function purgePageTx(tx: ContentTransaction, input: PurgePageInput): Promise<{ slug: string }> {
  const page = await tx.page.findFirst({ where: { id: input.pageId, wikiId: input.wikiId } });
  if (!page) throw new ContentNotFoundError("page");
  if (page.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, page.currentVersion);
  }
  const entries = await tx.knowledgeBuildPageRevision.findMany({
    where: { pageId: page.id },
    select: { buildId: true, pageRevisionId: true },
  });
  const revisionIds = entries.map((entry) => entry.pageRevisionId);
  const jsonBuilds = await tx.knowledgeBuild.findMany({
    where: { wikiId: input.wikiId, restorable: true },
    select: { id: true, publishedManifest: true },
  });
  const referencedInJson = jsonBuilds
    .filter((build) => {
      const manifest = JSON.stringify(build.publishedManifest);
      return manifest.includes(page.id) || revisionIds.some((revisionId) => manifest.includes(revisionId));
    })
    .map((build) => build.id);
  await markBuildsUnrestorable(
    tx,
    input.wikiId,
    [...entries.map((entry) => entry.buildId), ...referencedInJson],
    `page permanently purged: ${page.slug}`,
  );
  // FK SET NULL이 child projection만 몰래 바꾸지 않도록 dependent Page도 새 CAS revision으로
  // detach한다. 과거 revision은 append-only로 기존 parentId를 보존한다.
  const children = await tx.page.findMany({
    where: { wikiId: input.wikiId, parentId: page.id },
    select: { id: true, currentVersion: true },
    orderBy: { id: "asc" },
  });
  for (const child of children) {
    await updatePageSnapshotTx(tx, {
      wikiId: input.wikiId,
      pageId: child.id,
      expectedVersion: child.currentVersion,
      changes: { parentId: null },
      preserveOriginOnRestore: true,
      context: { actor: "system", reason: `parent permanently purged: ${page.slug}` },
    });
  }
  await tx.searchChunk.deleteMany({ where: { wikiId: input.wikiId, refType: "page", refId: page.id } });
  const removed = await tx.page.deleteMany({
    where: { id: page.id, wikiId: input.wikiId, currentVersion: input.expectedVersion },
  });
  if (removed.count !== 1) throw new ContentVersionConflictError(input.expectedVersion);
  return { slug: page.slug };
}

export function purgePage(input: PurgePageInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => purgePageTx(tx, input));
}

export interface PurgeSourceInput {
  wikiId: string;
  sourceId: string;
  expectedVersion: number;
}

export async function purgeSourceTx(
  tx: ContentTransaction,
  input: PurgeSourceInput,
): Promise<{ slug: string; storageKeys: string[]; cleanupLogId: string | null }> {
  const source = await tx.source.findFirst({ where: { id: input.sourceId, wikiId: input.wikiId } });
  if (!source) throw new ContentNotFoundError("source");
  if (source.currentVersion !== input.expectedVersion) {
    throw new ContentVersionConflictError(input.expectedVersion, source.currentVersion);
  }
  const revisions = await tx.sourceRevision.findMany({
    where: { sourceId: source.id },
    select: { id: true, storageKey: true },
  });
  const revisionIds = revisions.map((revision) => revision.id);
  const storageKeys = unique([
    ...(source.storageKey ? [source.storageKey] : []),
    ...revisions.flatMap((revision) => revision.storageKey ? [revision.storageKey] : []),
  ]);
  const manifestEntries = await tx.knowledgeBuildPageRevision.findMany({
    where: {
      pageRevision: {
        sources: { some: { sourceRevision: { sourceId: source.id } } },
      },
    },
    select: { buildId: true },
  });
  const jsonBuilds = await tx.knowledgeBuild.findMany({
    where: { wikiId: input.wikiId, restorable: true },
    select: { id: true, inputManifest: true, relationManifest: true, publishedManifest: true },
  });
  const referencedInJson = jsonBuilds
    .filter((build) => {
      const manifest = `${JSON.stringify(build.inputManifest)}\n${JSON.stringify(build.relationManifest)}\n${JSON.stringify(build.publishedManifest)}`;
      return revisionIds.some((revisionId) => manifest.includes(revisionId));
    })
    .map((build) => build.id);
  await markBuildsUnrestorable(
    tx,
    input.wikiId,
    [...manifestEntries.map((entry) => entry.buildId), ...referencedInJson],
    `source permanently purged: ${source.slug}`,
  );
  // current revision provenance에서 이 SourceRevision을 쓰는 non-note Page는 Source 삭제 FK가
  // projection/revision join만 몰래 바꾸기 전에 새 detach/stale revision을 남긴다.
  const dependentRevisions = await tx.pageRevision.findMany({
    where: {
      page: { wikiId: input.wikiId, kind: { not: "note" } },
      sources: { some: { sourceRevision: { sourceId: source.id } } },
    },
    select: {
      version: true,
      page: { select: { id: true, currentVersion: true, sourceId: true, origin: true } },
      sources: { select: { sourceRevisionId: true, sourceRevision: { select: { sourceId: true } } } },
    },
  });
  const currentDependents = dependentRevisions
    .filter((revision) => revision.version === revision.page.currentVersion)
    .sort((a, b) => a.page.id.localeCompare(b.page.id));
  for (const dependent of currentDependents) {
    await updatePageSnapshotTx(tx, {
      wikiId: input.wikiId,
      pageId: dependent.page.id,
      expectedVersion: dependent.page.currentVersion,
      changes: {
        ...(dependent.page.sourceId === source.id ? { sourceId: null } : {}),
        ...(dependent.page.origin === "generated" ? { staleAt: new Date() } : {}),
      },
      sourceRevisionIds: dependent.sources
        .filter((entry) => entry.sourceRevision.sourceId !== source.id)
        .map((entry) => entry.sourceRevisionId),
      preserveOriginOnRestore: true,
      context: { actor: "system", reason: `Source permanently purged: ${source.slug}` },
    });
  }
  // Source 전용 note는 projection이 아니라 Source 내용의 파생 복사다. Source만 지우고 note
  // revision/body를 남기면 영구 삭제 뒤에도 로컬 FTS와 history에서 원문 요약이 생존한다.
  const sourceNotes = await tx.page.findMany({
    where: { wikiId: input.wikiId, sourceId: source.id, kind: "note" },
    select: { id: true, currentVersion: true },
    orderBy: { id: "asc" },
  });
  for (const note of sourceNotes) {
    await purgePageTx(tx, {
      wikiId: input.wikiId,
      pageId: note.id,
      expectedVersion: note.currentVersion,
    });
  }
  // Blob store와 DB는 단일 transaction이 될 수 없다. Source를 지우기 전에 exact key를
  // wiki-scoped durable job으로 남겨 route crash/worker restart 뒤에도 재시도 가능하게 한다.
  const cleanupLog = storageKeys.length
    ? await tx.logEntry.create({
        data: {
          wikiId: input.wikiId,
          kind: "ingest",
          title: BLOB_PURGE_PENDING_TITLE,
          detail: blobPurgePayload(source.slug, storageKeys),
        },
        select: { id: true },
      })
    : null;
  await tx.searchChunk.deleteMany({ where: { wikiId: input.wikiId, refType: "source", refId: source.id } });
  const removed = await tx.source.deleteMany({
    where: { id: source.id, wikiId: input.wikiId, currentVersion: input.expectedVersion },
  });
  if (removed.count !== 1) throw new ContentVersionConflictError(input.expectedVersion);
  return { slug: source.slug, storageKeys, cleanupLogId: cleanupLog?.id ?? null };
}

export function purgeSource(input: PurgeSourceInput) {
  return withModelPolicyWriteLock(input.wikiId, (tx) => purgeSourceTx(tx, input));
}
