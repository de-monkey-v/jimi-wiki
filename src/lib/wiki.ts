import "server-only";
import { prisma } from "@/lib/db";
import { normalizeSlug } from "@/lib/markdown";
import { KIND_LABEL } from "@/lib/kinds";
import type { TocSection, TocEntry, TocFolder, TocLeaf, WikiGraph, GraphNode, GraphEdge } from "@/lib/kinds";
import { isReservedSlug, ONTOLOGY_SLUG } from "@/lib/ontology";
import {
  archivePageSnapshot,
  ContentVersionConflictError,
  createPageSnapshot,
  updatePageSnapshotTx,
} from "@/lib/content-store";
import { refreshPageDerivedState } from "@/lib/page-projections";
import { reindexEmbeddings } from "@/lib/search";
import { archiveSourceWithPropagation } from "@/lib/model-policy";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import type {
  DocumentType,
  ModelAccess,
  PageKind,
  WikiKind,
  Visibility,
  RelationType,
  RevisionActor,
} from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

// 페이지 생성/수정 공통 입력. category/sourceId는 undefined=미변경, null=해제, 값=설정.
// 호출부 호환을 유지하면서 revision 계층의 정책/작성 주체를 선택적으로 전달할 수 있게 한다.
type PageWrite = {
  title: string;
  kind: PageKind;
  body: string;
  category?: string | null;
  documentType?: DocumentType | null;
  documentAt?: Date | null;
  sourceId?: string | null;
  sourceRevisionIds?: string[];
  modelAccess?: ModelAccess;
  userId?: string | null;
  reason?: string | null;
  actor?: RevisionActor;
  /** update/upsert existing Page의 클라이언트가 읽은 version. create에는 불필요하다. */
  expectedVersion?: number;
};

// ---------- 슬러그 ----------
// check-then-create(TOCTOU) 대신 unique 위반(P2002)을 잡아 다음 접미로 재시도
const isP2002 = (e: unknown) => (e as { code?: string })?.code === "P2002";

async function reindexPageEmbeddingIfEligible(
  wikiId: string,
  page: { modelAccess: ModelAccess; kind: PageKind; archivedAt: Date | null },
): Promise<void> {
  if (page.modelAccess === "external" && page.kind !== "personal" && !page.archivedAt) {
    await reindexEmbeddings(wikiId).catch(() => null);
  }
}

// ---------- 위키 ----------
export function listWikisForUser(userId: string) {
  return prisma.wiki.findMany({
    where: { memberships: { some: { userId } } },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { pages: true } } },
  });
}

/** 내가 만든 위키. */
export function listOwnedWikis(userId: string) {
  return prisma.wiki.findMany({
    where: { createdById: userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { pages: true } } },
  });
}

/** 남이 나를 초대한 위키(내가 만들지 않았지만 멤버인 것) + 내 역할. */
export async function listSharedWikis(userId: string) {
  const rows = await prisma.wiki.findMany({
    where: { memberships: { some: { userId } }, NOT: { createdById: userId } },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { pages: true } },
      memberships: { where: { userId }, select: { role: true }, take: 1 },
      createdBy: { select: { name: true, email: true } },
    },
  });
  return rows.map((w) => ({ ...w, myRole: w.memberships[0]?.role }));
}

export async function createWiki(userId: string, input: { title: string; kind: WikiKind; description?: string }) {
  const root = normalizeSlug(input.title) || "wiki";
  for (let i = 0; ; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    try {
      return await prisma.wiki.create({
        data: {
          slug,
          title: input.title.trim() || "제목 없는 위키",
          description: input.description?.trim() || null,
          kind: input.kind,
          createdById: userId,
          memberships: { create: { userId, role: "owner" } },
        },
      });
    } catch (e) {
      if (isP2002(e) && i < 50) continue;
      throw e;
    }
  }
}

/** 접근 권한 확인과 함께 위키 조회. 멤버가 아니면 null */
export async function getWikiForUser(userId: string, slug: string) {
  const wiki = await prisma.wiki.findUnique({
    where: { slug },
    include: { memberships: { where: { userId }, take: 1 } },
  });
  if (!wiki || wiki.memberships.length === 0) return null;
  return { ...wiki, role: wiki.memberships[0].role };
}

export function listPages(wikiId: string) {
  return prisma.page.findMany({
    where: { wikiId, archivedAt: null },
    orderBy: [{ kind: "asc" }, { title: "asc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      documentType: true,
      documentAt: true,
      origin: true,
      modelAccess: true,
      currentVersion: true,
      archivedAt: true,
      updatedAt: true,
    },
  });
}

export function getPage(wikiId: string, slug: string) {
  return prisma.page.findFirst({ where: { wikiId, slug, archivedAt: null } });
}

export async function existingSlugSet(wikiId: string): Promise<Set<string>> {
  const rows = await prisma.page.findMany({ where: { wikiId }, select: { slug: true } });
  return new Set(rows.map((r) => r.slug));
}

// ---------- 목차(TOC) 트리 ----------
// KIND_LABEL·Toc 타입은 클라이언트 공용 모듈에서 가져와 재수출(기존 server import 호환).
export { KIND_LABEL };
export type { TocSection, TocEntry };

/**
 * 위키의 페이지를 kind(카테고리)별 섹션으로 묶고, 각 섹션 안에서 parentId+sortOrder 트리로.
 * flat은 kind 순서 → 섹션 내 전위순회(이전/다음용). 사이드바·이전/다음·공개읽기가 이 하나를 공유.
 */
/**
 * 탐색기(VSCode식) 목차: 2섹션 — 원문/소스(note) vs 정리된 지식(파생, category 경로 폴더 트리).
 * flat은 섹션 순 전위순회(이전/다음용). getPrevNext는 이 flat만 쓰므로 시그니처 불변.
 */
/** category 경로("ai/architectures")로 페이지들을 폴더 트리(TocEntry[])로 배치. 미분류는 루트 leaf(=Inbox). */
function buildCategoryTree(pages: { slug: string; title: string; kind: PageKind; category: string | null; currentVersion: number }[]): TocEntry[] {
  const rootChildren: TocEntry[] = [];
  const folderByPath = new Map<string, TocFolder>();
  const ensureFolder = (path: string): TocFolder => {
    const hit = folderByPath.get(path);
    if (hit) return hit;
    const parts = path.split("/");
    const folder: TocFolder = { type: "folder", name: parts[parts.length - 1], path, children: [] };
    folderByPath.set(path, folder);
    const parentPath = parts.slice(0, -1).join("/");
    if (parentPath) ensureFolder(parentPath).children.push(folder);
    else rootChildren.push(folder);
    return folder;
  };
  for (const p of pages) {
    const leaf: TocLeaf = { type: "page", slug: p.slug, title: p.title, kind: p.kind, currentVersion: p.currentVersion };
    // 빈 세그먼트 정규화("ai/models/"·"ai//models" → "ai/models")로 빈 폴더/분열 방지
    const cat = p.category?.split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (cat) ensureFolder(cat).children.push(leaf);
    else rootChildren.push(leaf); // 미분류는 섹션 루트에(Inbox)
  }
  return rootChildren;
}

/**
 * 4섹션 목차: 보호 메모 · 문서 · 원문/소스 · 정리된 지식.
 * opts.includePersonal=false면 personal 섹션 제외(공개 뷰). personal은 AI 코퍼스엔 없지만 사이드바 탐색엔 노출된다(제목/트리).
 */
export async function getWikiToc(
  wikiId: string,
  opts?: { includePersonal?: boolean },
): Promise<{ sections: TocSection[]; flat: { slug: string; title: string }[] }> {
  const includePersonal = opts?.includePersonal ?? true;
  const pages = await prisma.page.findMany({
    where: { wikiId, archivedAt: null, slug: { not: ONTOLOGY_SLUG } }, // O1: system 온톨로지 페이지 숨김
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: { slug: true, title: true, kind: true, category: true, currentVersion: true },
  });

  const personalPages = includePersonal ? pages.filter((p) => p.kind === "personal") : [];
  const sourceEntries: TocEntry[] = pages
    .filter((p) => p.kind === "note")
    .map((p) => ({ type: "page", slug: p.slug, title: p.title, kind: p.kind, currentVersion: p.currentVersion }));
  const documentPages = pages.filter((p) => p.kind === "document");
  const derivedPages = pages.filter((p) => !["note", "document", "personal"].includes(p.kind)); // concept/entity/meta

  const personalEntries = buildCategoryTree(personalPages);
  const documentEntries = buildCategoryTree(documentPages);
  const knowledgeEntries = buildCategoryTree(derivedPages);

  const sections: TocSection[] = [
    ...(includePersonal ? [{ key: "personal" as const, entries: personalEntries }] : []),
    { key: "documents", entries: documentEntries },
    { key: "sources", entries: sourceEntries },
    { key: "knowledge", entries: knowledgeEntries },
  ];

  const flat: { slug: string; title: string }[] = [];
  const walk = (entries: TocEntry[]) => {
    for (const e of entries) {
      if (e.type === "page") flat.push({ slug: e.slug, title: e.title });
      else walk(e.children);
    }
  };
  for (const s of sections) walk(s.entries);

  return { sections, flat };
}

/** 목차 순서 기준 이전/다음 페이지. 첫/마지막/미포함은 해당 방향 null. */
export async function getPrevNext(
  wikiId: string,
  slug: string,
  opts?: { includePersonal?: boolean },
): Promise<{ prev: { slug: string; title: string } | null; next: { slug: string; title: string } | null }> {
  const { flat } = await getWikiToc(wikiId, opts);
  const i = flat.findIndex((f) => f.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return { prev: i > 0 ? flat[i - 1] : null, next: i < flat.length - 1 ? flat[i + 1] : null };
}

/** 새 페이지의 sortOrder = 형제 중 max+1 (끝에 append). */
async function nextSortOrder(wikiId: string, parentId: string | null): Promise<number> {
  const agg = await prisma.page.aggregate({ where: { wikiId, parentId, archivedAt: null }, _max: { sortOrder: true } });
  return (agg._max.sortOrder ?? -1) + 1;
}

// ---------- 위키 설정/공개 ----------
export function updateWikiSettings(
  wikiId: string,
  input: { title?: string; description?: string | null; visibility?: Visibility; kind?: WikiKind },
) {
  return prisma.wiki.update({
    where: { id: wikiId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() || "제목 없는 위키" } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    },
  });
}

export async function deleteWiki(wikiId: string) {
  const res = await prisma.wiki.delete({ where: { id: wikiId } }); // cascade로 pages/sources/chunks/members 등 삭제
  // DB cascade는 blob 원본을 지우지 않으므로 이 위키의 blob 접두사를 통째 정리(고아 방지, 비치명적)
  await import("@/lib/blob").then((m) => m.getBlobStore().deletePrefix(`${wikiId}/`)).catch(() => {});
  return res;
}

// ---------- 페이지 생성/수정 ----------
async function currentSourceRevisionIds(
  wikiId: string,
  sourceId: string | null | undefined,
): Promise<string[] | undefined> {
  if (sourceId === undefined) return undefined;
  if (sourceId === null) return [];
  const source = await prisma.source.findFirst({
    where: { id: sourceId, wikiId, archivedAt: null },
    select: {
      currentVersion: true,
      revisions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true } },
    },
  });
  const revision = source?.revisions[0];
  if (!source || !revision || revision.version !== source.currentVersion) {
    throw new Error("현재 SourceRevision을 찾을 수 없습니다");
  }
  return [revision.id];
}

export async function createPage(
  wikiId: string,
  input: {
    title: string;
    kind: PageKind;
    body?: string;
    category?: string | null;
    documentType?: DocumentType | null;
    documentAt?: Date | null;
    sourceId?: string | null;
    sourceRevisionIds?: string[];
    slug?: string;
    modelAccess?: ModelAccess;
    userId?: string | null;
    reason?: string | null;
    actor?: RevisionActor;
  },
) {
  // 명시 slug(예: 미해결 [[link]]에서 생성 — slug===target 불변): 충돌 시 접미 증가 대신 기존 페이지 반환.
  const explicit = !!input.slug;
  const normalizedRoot = normalizeSlug(input.slug || input.title) || "page";
  if (input.slug && isReservedSlug(normalizedRoot)) {
    throw new Error(`예약된 system slug입니다: ${normalizedRoot}`);
  }
  // 제목에서 유도된 slug가 정적 라우트와 충돌하면 접근 가능한 안전한 slug로 바꾼다.
  const root = isReservedSlug(normalizedRoot) ? `${normalizedRoot}-page` : normalizedRoot;
  const sortOrder = await nextSortOrder(wikiId, null);
  const sourceRevisionIds = input.sourceRevisionIds ?? (await currentSourceRevisionIds(wikiId, input.sourceId));
  for (let i = 0; ; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    try {
      const { page } = await createPageSnapshot({
        wikiId,
        slug,
        title: input.title.trim() || "제목 없음",
        kind: input.kind,
        body: input.body ?? "",
        sortOrder,
        category: input.category ?? null,
        documentType: input.documentType ?? null,
        documentAt: input.documentAt ?? null,
        sourceId: input.sourceId ?? null,
        modelAccess: input.modelAccess,
        sourceRevisionIds,
        context: {
          actor: input.actor ?? "human",
          userId: input.userId ?? null,
          reason: input.reason ?? "page create",
        },
      });
      await refreshPageDerivedState(wikiId, page.id);
      await reindexPageEmbeddingIfEligible(wikiId, page);
      return page;
    } catch (e) {
      if (isP2002(e)) {
        if (explicit) {
          const existing = await prisma.page.findUnique({ where: { wikiId_slug: { wikiId, slug: root } } });
          if (existing?.archivedAt) throw new Error(`보관된 페이지가 slug를 점유하고 있습니다: ${root}`);
          if (existing) return existing; // slug===target 유지, 기존 active 페이지로 이동
        }
        if (i < 50) continue;
      }
      throw e;
    }
  }
}

// ---------- 개인 노트 이동(refile) + 핀 ----------
/** 페이지 category만 변경(move/refile). 빈/null이면 미분류(Inbox). 링크·색인 재계산 없이 가벼운 업데이트. */
export async function setPageCategory(
  wikiId: string,
  slug: string,
  category: string | null,
  expectedVersion: number,
  userId?: string | null,
): Promise<void> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) throw new Error("expectedVersion is required");
  const result = await withModelPolicyWriteLock(wikiId, async (tx) => {
    const page = await tx.page.findFirstOrThrow({ where: { wikiId, slug, archivedAt: null } });
    return updatePageSnapshotTx(tx, {
      wikiId,
      pageId: page.id,
      expectedVersion,
      changes: { category: category || null },
      context: { actor: "human", userId: userId ?? null, reason: "page category changed" },
    });
  });
  await refreshPageDerivedState(wikiId, result.page.id);
  await reindexPageEmbeddingIfEligible(wikiId, result.page);
}

/** 유저가 이 위키에서 고정한 페이지들(개인 핀). 최신 고정 순. */
export async function listPins(wikiId: string, userId: string): Promise<{ slug: string; title: string; kind: PageKind }[]> {
  const rows = await prisma.pagePin.findMany({
    where: { wikiId, userId, page: { archivedAt: null } },
    orderBy: { createdAt: "desc" },
    select: { page: { select: { slug: true, title: true, kind: true } } },
  });
  return rows.map((r) => r.page);
}

export async function isPagePinned(userId: string, pageId: string): Promise<boolean> {
  const pin = await prisma.pagePin.findUnique({ where: { userId_pageId: { userId, pageId } }, select: { id: true } });
  return !!pin;
}

/** 유저가 이 위키에서 고정한 폴더(category 경로)들. 최신 고정 순. */
export async function listFolderPins(wikiId: string, userId: string): Promise<{ category: string }[]> {
  return prisma.folderPin.findMany({
    where: { wikiId, userId },
    orderBy: { createdAt: "desc" },
    select: { category: true },
  });
}

export async function isFolderPinned(userId: string, wikiId: string, category: string): Promise<boolean> {
  const pin = await prisma.folderPin.findUnique({
    where: { userId_wikiId_category: { userId, wikiId, category } },
    select: { id: true },
  });
  return !!pin;
}

export async function updatePage(wikiId: string, slug: string, input: PageWrite) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion! <= 0) {
    throw new Error("expectedVersion is required for Page update");
  }
  const sourceRevisionIds = input.sourceRevisionIds ?? (await currentSourceRevisionIds(wikiId, input.sourceId));
  const { page } = await withModelPolicyWriteLock(wikiId, async (tx) => {
    const current = await tx.page.findFirstOrThrow({ where: { wikiId, slug, archivedAt: null } });
    return updatePageSnapshotTx(tx, {
      wikiId,
      pageId: current.id,
      expectedVersion: input.expectedVersion!,
      changes: {
        title: input.title.trim() || "제목 없음",
        kind: input.kind,
        body: input.body,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.documentType !== undefined ? { documentType: input.documentType } : {}),
        ...(input.documentAt !== undefined ? { documentAt: input.documentAt } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.modelAccess !== undefined ? { modelAccess: input.modelAccess } : {}),
      },
      sourceRevisionIds,
      context: {
        actor: input.actor ?? "human",
        userId: input.userId ?? null,
        reason: input.reason ?? "page update",
      },
    });
  });
  await refreshPageDerivedState(wikiId, page.id);
  await reindexPageEmbeddingIfEligible(wikiId, page);
  return page;
}

/**
 * slug를 명시해 생성/수정(에이전트 writePage용). slug가 이미 있으면 수정, 없으면 그 slug로 생성.
 * slug 미지정이면 title에서 유도(createPage).
 */
export async function upsertPage(
  wikiId: string,
  input: { slug?: string } & PageWrite,
): Promise<{ slug: string; created: boolean }> {
  const wanted = input.slug ? normalizeSlug(input.slug) : "";
  // O2: system 페이지(ontology 등)는 일반 경로로 쓸 수 없다. 온톨로지 변경은 setOntology 전용.
  if (wanted && isReservedSlug(wanted)) throw new Error(`예약된 system slug입니다: ${wanted}`);
  if (wanted) {
    const occupied = await prisma.page.findUnique({ where: { wikiId_slug: { wikiId, slug: wanted } } });
    if (occupied?.archivedAt) throw new Error(`보관된 페이지가 slug를 점유하고 있습니다: ${wanted}`);
    const existing = await getPage(wikiId, wanted);
    if (existing) {
      await updatePage(wikiId, wanted, input);
      return { slug: wanted, created: false };
    }
    try {
      const sourceRevisionIds = input.sourceRevisionIds ?? (await currentSourceRevisionIds(wikiId, input.sourceId));
      const { page } = await createPageSnapshot({
        wikiId,
        slug: wanted,
        title: input.title.trim() || "제목 없음",
        kind: input.kind,
        body: input.body,
        sortOrder: await nextSortOrder(wikiId, null),
        category: input.category ?? null,
        documentType: input.documentType ?? null,
        documentAt: input.documentAt ?? null,
        sourceId: input.sourceId ?? null,
        modelAccess: input.modelAccess,
        sourceRevisionIds,
        context: {
          actor: input.actor ?? "human",
          userId: input.userId ?? null,
          reason: input.reason ?? "page upsert create",
        },
      });
      await refreshPageDerivedState(wikiId, page.id);
      return { slug: page.slug, created: true };
    } catch (e) {
      // 생성 직전 경합으로 같은 slug가 만들어졌으면 수정으로 폴백
      if (isP2002(e)) {
        const occupied = await prisma.page.findUnique({ where: { wikiId_slug: { wikiId, slug: wanted } } });
        if (occupied?.archivedAt) throw new Error(`보관된 페이지가 slug를 점유하고 있습니다: ${wanted}`);
        // create 직전 다른 writer가 같은 slug를 선점했다. 호출자는 그 version을 읽지 않았으므로
        // 새 행을 조용히 덮어쓰지 않고 명시적 optimistic-concurrency 충돌을 반환한다.
        throw new ContentVersionConflictError(0, occupied?.currentVersion);
      }
      throw e;
    }
  }
  const page = await createPage(wikiId, input);
  return { slug: page.slug, created: true };
}

/**
 * 기존 DELETE 호환 facade. 실제 행·revision은 지우지 않고 suppression archive revision을 남긴다.
 * 반환: archive했으면 true, active 페이지가 없으면 false.
 */
export async function deletePage(wikiId: string, slug: string): Promise<boolean> {
  const page = await prisma.page.findFirst({
    where: { wikiId, slug, archivedAt: null },
    select: { id: true, currentVersion: true },
  });
  if (!page) return false;
  await archivePageSnapshot({
    wikiId,
    pageId: page.id,
    expectedVersion: page.currentVersion,
    suppression: true,
    context: { actor: "human", reason: "page archived" },
  });
  await refreshPageDerivedState(wikiId, page.id);
  return true;
}

/**
 * 원문(Source) 삭제 시 영향받는 것들(삭제 전 경고 UI용).
 * - notes: 함께 삭제될 소스 노트(요약, 1:1 쌍)
 * - derived: 남지만 이 원문 출처를 잃는 정리된 지식(concept/entity, M:N 기여)
 */
export async function getSourceImpact(
  wikiId: string,
  sourceId: string,
): Promise<{ notes: { slug: string; title: string }[]; derived: { slug: string; title: string }[] }> {
  const [notes, contribs] = await Promise.all([
    prisma.page.findMany({ where: { wikiId, sourceId, kind: "note" }, select: { slug: true, title: true }, orderBy: { title: "asc" } }),
    prisma.pageContribution.findMany({
      where: { wikiId, sourceId },
      select: { page: { select: { slug: true, title: true } } },
      orderBy: { page: { title: "asc" } },
    }),
  ]);
  return { notes, derived: contribs.map((c) => c.page) };
}

/**
 * 기존 DELETE 호환 facade. Source와 note는 archive revision으로 보존하고 영향 generated Page는 stale 처리한다.
 * 반환 필드명 deletedNotes는 구 API 호환이며 실제 의미는 함께 archive된 note slug다.
 */
export async function deleteSource(
  wikiId: string,
  slug: string,
  userId?: string | null,
): Promise<{ deletedNotes: string[] } | null> {
  const source = await prisma.source.findFirst({
    where: { wikiId, slug, archivedAt: null },
    select: { id: true, currentVersion: true },
  });
  if (!source) return null;
  const notes = await prisma.page.findMany({
    where: { wikiId, sourceId: source.id, kind: "note", archivedAt: null },
    select: { slug: true },
  });
  await archiveSourceWithPropagation({
    wikiId,
    sourceId: source.id,
    expectedVersion: source.currentVersion,
    userId: userId ?? null,
    reason: "source archived through legacy delete facade",
  });
  return { deletedNotes: notes.map((n) => n.slug) };
}

/** 이 페이지로 들어오는 백링크(출발 페이지 목록) */
export async function getBacklinks(wikiId: string, pageId: string) {
  const links = await prisma.pageLink.findMany({
    where: { wikiId, toPageId: pageId },
    select: { from: { select: { slug: true, title: true } } },
  });
  const seen = new Set<string>();
  const out: { slug: string; title: string }[] = [];
  for (const l of links) {
    if (seen.has(l.from.slug)) continue;
    seen.add(l.from.slug);
    out.push(l.from);
  }
  return out;
}

/** 이 페이지가 참조하는 문서(해소된 아웃링크 목록). 깨진 링크(toPageId null)는 제외. */
export async function getOutlinks(wikiId: string, pageId: string) {
  const links = await prisma.pageLink.findMany({
    where: { wikiId, fromPageId: pageId, toPageId: { not: null } },
    select: { to: { select: { slug: true, title: true } } },
  });
  const seen = new Set<string>();
  const out: { slug: string; title: string }[] = [];
  for (const l of links) {
    if (!l.to || seen.has(l.to.slug)) continue;
    seen.add(l.to.slug);
    out.push(l.to);
  }
  return out;
}

/** 이 페이지가 파생된 원문(provenance). sourceId 없으면 null. */
export async function getPageProvenance(wikiId: string, sourceId: string | null) {
  if (!sourceId) return null;
  return prisma.source.findFirst({
    where: { id: sourceId, wikiId },
    select: { slug: true, title: true, url: true },
  });
}

/** 원문(Source) 단건 조회(원문 뷰어용). */
export function getSource(wikiId: string, slug: string) {
  return prisma.source.findFirst({ where: { wikiId, slug, archivedAt: null } });
}

/** 원문(Source) id 목록 → slug/title (채팅 근거의 원문 히트 해소용, wikiId 스코프). */
export async function getSourcesByIds(
  wikiId: string,
  ids: string[],
): Promise<{ id: string; slug: string; title: string }[]> {
  if (ids.length === 0) return [];
  return prisma.source.findMany({
    where: { wikiId, id: { in: ids }, archivedAt: null },
    select: { id: true, slug: true, title: true },
  });
}

/** 파생 페이지 → exact SourceRevision provenance와 현재 PageContribution projection을 함께 보강(멱등). */
export async function addPageSource(
  wikiId: string,
  pageSlug: string,
  sourceId: string,
  userId?: string | null,
): Promise<void> {
  const pageId = await withModelPolicyWriteLock(wikiId, async (tx) => {
    const [page, source] = await Promise.all([
      tx.page.findFirst({
        where: { wikiId, slug: pageSlug, archivedAt: null },
        select: {
          id: true,
          currentVersion: true,
          revisions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { version: true, sources: { select: { sourceRevisionId: true } } },
          },
        },
      }),
      tx.source.findFirst({
        where: { id: sourceId, wikiId, archivedAt: null },
        select: {
          id: true,
          currentVersion: true,
          revisions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { id: true, version: true, archivedAt: true },
          },
        },
      }), // 테넌트 격리: 원본도 같은 위키여야
    ]);
    if (!page || !source) return null;
    const pageRevision = page.revisions[0];
    const sourceRevision = source.revisions[0];
    if (
      !pageRevision ||
      pageRevision.version !== page.currentVersion ||
      !sourceRevision ||
      sourceRevision.version !== source.currentVersion ||
      sourceRevision.archivedAt != null
    ) return null;
    const sourceRevisionIds = [
      ...new Set([
        ...pageRevision.sources.map((entry) => entry.sourceRevisionId),
        sourceRevision.id,
      ]),
    ];
    if (!pageRevision.sources.some((entry) => entry.sourceRevisionId === sourceRevision.id)) {
      const saved = await updatePageSnapshotTx(tx, {
        wikiId,
        pageId: page.id,
        expectedVersion: page.currentVersion,
        changes: {},
        sourceRevisionIds,
        context: { actor: "human", userId: userId ?? null, reason: "source provenance attached" },
      });
      if (saved.projection.modelAccess === "internalOnly") {
        await tx.$executeRawUnsafe(
          `UPDATE "SearchChunk" SET embedding = NULL WHERE "wikiId"=$1 AND "refType"='page' AND "refId"=$2`,
          wikiId,
          page.id,
        );
        await tx.searchChunk.updateMany({
          where: { wikiId, refType: "page", refId: page.id },
          data: { modelAccess: "internalOnly" },
        });
      }
    }
    await tx.pageContribution.upsert({
      where: { pageId_sourceId: { pageId: page.id, sourceId } },
      create: { wikiId, pageId: page.id, sourceId },
      update: {},
    });
    return page.id;
  });
  if (pageId) await refreshPageDerivedState(wikiId, pageId);
}

// ---------- 개념 간 타입드 관계(KG 엣지) ----------
export interface RelationTuple {
  fromSlug: string;
  toSlug: string;
  type: RelationType;
}

/**
 * 이 원문(Source)이 근거하는 개념 관계를 통째로 교체(set-replace, 멱등). ingest 추출 패스가 원문당 1회 호출한다.
 * fromSlug/toSlug 는 이 위키의 기존 페이지여야 한다(테넌트 격리 + 존재하지 않는 endpoint·자기루프 거부).
 * 원문당 정확히 그 원문의 엣지만 지우고 다시 넣으므로 재수집이 멱등 — 여러 원문이 같은 논리 엣지를 주장하면
 * 물리적으로 N행(순회 시 dedup). 반환: 실제로 기록한 엣지 수.
 */
export async function replaceSourceRelations(
  wikiId: string,
  sourceId: string,
  tuples: RelationTuple[],
): Promise<number> {
  return withModelPolicyWriteLock(wikiId, async (tx) => {
    const source = await tx.source.findFirst({
      where: { id: sourceId, wikiId, archivedAt: null, modelAccess: "external", curationState: "curated" },
      select: {
        id: true,
        currentVersion: true,
        revisions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, archivedAt: true } },
      },
    });
    const sourceRevision = source?.revisions[0];
    if (
      !source ||
      !sourceRevision ||
      sourceRevision.version !== source.currentVersion ||
      sourceRevision.archivedAt != null
    ) return 0;
    const slugs = [...new Set(tuples.flatMap((tuple) => [tuple.fromSlug, tuple.toSlug]))];
    const pages = slugs.length
      ? await tx.page.findMany({
        where: { wikiId, slug: { in: slugs }, archivedAt: null, kind: { in: ["concept", "entity"] } },
        select: { id: true, slug: true },
      })
      : [];
    const idBySlug = new Map(pages.map((page) => [page.slug, page.id]));

    const rows: Prisma.ConceptRelationCreateManyInput[] = [];
    const seen = new Set<string>();
    for (const tuple of tuples) {
      const fromPageId = idBySlug.get(tuple.fromSlug);
      const toPageId = idBySlug.get(tuple.toSlug);
      if (!fromPageId || !toPageId || fromPageId === toPageId) continue; // 미존재 endpoint·자기루프 드롭
      const key = `${fromPageId}|${toPageId}|${tuple.type}`;
      if (seen.has(key)) continue; // 이 원문 내 중복 튜플 제거(@@unique 위반 회피)
      seen.add(key);
      rows.push({
        wikiId,
        fromPageId,
        toPageId,
        type: tuple.type,
        sourceId,
        sourceRevisionId: sourceRevision.id,
      });
    }
    await tx.conceptRelation.deleteMany({ where: { wikiId, sourceId } });
    if (rows.length) await tx.conceptRelation.createMany({ data: rows, skipDuplicates: true });
    return rows.length;
  });
}

/** 이 파생 페이지가 유래한 원본(들). 기여 순(ingest 시각). note의 단일 provenance와 별개. */
export async function getPageSources(
  wikiId: string,
  pageId: string,
): Promise<{ slug: string; title: string; url: string | null }[]> {
  const rows = await prisma.pageContribution.findMany({
    where: { wikiId, pageId },
    select: { source: { select: { slug: true, title: true, url: true } } },
    orderBy: { source: { ingestedAt: "asc" } },
  });
  return rows.map((r) => r.source);
}

// ---------- P3: 그래프 ----------
/** 위키 전체 링크 그래프. 문서를 포함한 일반 위키링크를 시각화한다. typed ConceptRelation 그래프와는 별개다. */
export async function getWikiGraph(wikiId: string): Promise<WikiGraph> {
  const [pages, links] = await Promise.all([
    prisma.page.findMany({
      where: { wikiId, archivedAt: null, slug: { not: ONTOLOGY_SLUG } },
      select: { id: true, slug: true, title: true, kind: true, category: true },
    }),
    prisma.pageLink.findMany({ where: { wikiId }, select: { fromPageId: true, toPageId: true, toSlug: true } }),
  ]);
  const idToSlug = new Map(pages.map((p) => [p.id, p.slug]));
  const slugSet = new Set(pages.map((p) => p.slug));

  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  const brokenTargets = new Set<string>();
  const seen = new Set<string>(); // 중복 엣지 제거(source|target)
  const bump = (s: string) => degree.set(s, (degree.get(s) ?? 0) + 1);

  for (const l of links) {
    const source = idToSlug.get(l.fromPageId);
    if (!source) continue; // 노드 집합 밖(예: ontology) 출발 링크 스킵
    let target: string | undefined;
    if (l.toPageId) {
      target = idToSlug.get(l.toPageId);
    } else if (l.toSlug && !slugSet.has(l.toSlug) && !isReservedSlug(l.toSlug)) {
      target = l.toSlug; // 깨진 링크 → ghost
      brokenTargets.add(l.toSlug);
    }
    if (!target || target === source) continue;
    // 무방향 dedup: 양방향 링크(a↔b)를 한 엣지·degree +1 로(중복 카운트 방지)
    const lo = source < target ? source : target;
    const hi = source < target ? target : source;
    const key = `${lo}\0${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source, target });
    bump(source);
    bump(target);
  }

  const nodes: GraphNode[] = pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    category: p.category,
    degree: degree.get(p.slug) ?? 0,
  }));
  for (const t of brokenTargets) {
    nodes.push({ slug: t, title: t, kind: null, category: null, degree: degree.get(t) ?? 0, broken: true });
  }
  return { nodes, edges };
}

/** 페이지 이웃 서브그래프(로컬 그래프). slug + depth홉 이내 노드/엣지. */
export async function getPageNeighborhood(wikiId: string, slug: string, depth = 1): Promise<WikiGraph> {
  const start = await prisma.page.findFirst({ where: { wikiId, slug, archivedAt: null }, select: { id: true } });
  if (!start) return { nodes: [], edges: [] };

  // BFS: 각 홉마다 프론티어 페이지의 in/out 해소링크만 조회(전체 그래프 로드 회피 — 핫 경로)
  const idSet = new Set<string>([start.id]);
  const edgePairs: [string, string][] = [];
  let frontier = [start.id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const links = await prisma.pageLink.findMany({
      where: { wikiId, toPageId: { not: null }, OR: [{ fromPageId: { in: frontier } }, { toPageId: { in: frontier } }] },
      select: { fromPageId: true, toPageId: true },
    });
    const next: string[] = [];
    for (const l of links) {
      const to = l.toPageId!;
      edgePairs.push([l.fromPageId, to]);
      for (const id of [l.fromPageId, to]) {
        if (!idSet.has(id)) {
          idSet.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const nodePages = await prisma.page.findMany({
    where: { wikiId, id: { in: [...idSet] }, archivedAt: null, slug: { not: ONTOLOGY_SLUG } },
    select: { id: true, slug: true, title: true, kind: true, category: true },
  });
  const idToSlug = new Map(nodePages.map((p) => [p.id, p.slug]));

  const degree = new Map<string, number>();
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const bump = (s: string) => degree.set(s, (degree.get(s) ?? 0) + 1);
  for (const [f, t] of edgePairs) {
    const s = idToSlug.get(f);
    const tg = idToSlug.get(t);
    if (!s || !tg || s === tg) continue; // 노드 집합 밖(ontology 등) 제외
    const lo = s < tg ? s : tg;
    const hi = s < tg ? tg : s;
    const key = `${lo}\0${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: s, target: tg });
    bump(s);
    bump(tg);
  }
  const nodes: GraphNode[] = nodePages.map((p) => ({
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    category: p.category,
    degree: degree.get(p.slug) ?? 0,
  }));
  return { nodes, edges };
}
