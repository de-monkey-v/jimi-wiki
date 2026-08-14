import "server-only";

import { updatePageSnapshotTx, type ContentTransaction } from "@/lib/content-store";
import { isPageMoveEligible } from "@/lib/kinds";
import { normalizeSlug } from "@/lib/markdown";
import { withModelPolicyWriteLock } from "@/lib/model-access";
import { sanitizeCategorySlug } from "@/lib/ontology";
import { refreshCategorySearchProjection } from "@/lib/search";

export const MAX_PAGE_CATEGORY_MOVE_ITEMS = 1_000;
export const PAGE_CATEGORY_MOVE_REASON = "page category moved";
export const PAGE_CATEGORY_UNDO_REASON = "page category move undone";

export type PageCategoryMoveRequest = { slug: string; expectedVersion: number };
export type PageCategoryMoveReceipt = {
  slug: string;
  originalCategory: string | null;
  category: string | null;
  newVersion: number;
};
export type PageCategoryUndoRequest = {
  slug: string;
  expectedVersion: number;
  originalCategory: string | null;
};
export type PageCategoryMoveResult = {
  moved: PageCategoryMoveReceipt[];
};

export type PageCategoryMoveErrorCode =
  | "invalidInput"
  | "invalidTarget"
  | "forbidden"
  | "notFound"
  | "notMovable"
  | "versionConflict"
  | "invalidUndo";

export class PageCategoryMoveError extends Error {
  constructor(
    readonly code: PageCategoryMoveErrorCode,
    readonly slug?: string,
    readonly actualVersion?: number,
  ) {
    super(code);
    this.name = "PageCategoryMoveError";
  }
}

function parseSlug(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  return normalizeSlug(value) === value ? value : null;
}

function parseExpectedVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * root는 null만 허용한다. DnD target은 DB에서 visible/pinned 여부를 다시 확인하므로
 * legacy 대소문자·공백 라벨은 보존하되, UI tree와 다른 경로로 해석될 입력은 거부한다.
 */
export function parsePageCategoryTarget(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const treePath = value.split("/").map((part) => part.trim()).filter(Boolean).join("/");
  return treePath === value ? value : undefined;
}

export function parsePageCategoryMoveInput(
  rawItems: unknown,
  rawCategory: unknown,
): { items: PageCategoryMoveRequest[]; category: string | null } | null {
  const category = parsePageCategoryTarget(rawCategory);
  if (category === undefined || !Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_PAGE_CATEGORY_MOVE_ITEMS) {
    return null;
  }
  const seen = new Set<string>();
  const items: PageCategoryMoveRequest[] = [];
  for (const value of rawItems) {
    if (!value || typeof value !== "object") return null;
    const slug = parseSlug((value as { slug?: unknown }).slug);
    const expectedVersion = parseExpectedVersion((value as { expectedVersion?: unknown }).expectedVersion);
    if (!slug || expectedVersion === null || seen.has(slug)) return null;
    seen.add(slug);
    items.push({ slug, expectedVersion });
  }
  return { items, category };
}

function parseOriginalCategory(value: unknown): string | null | undefined {
  if (value === null) return null;
  // Undo는 직전 DB revision과 정확히 대조한다. 레거시 category도 원문 그대로 복원할 수 있게
  // 새 이동 target보다 넓게 받되 길이를 제한하고, 검증된 직전 revision 없이는 쓸 수 없게 한다.
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  return value;
}

export function parsePageCategoryUndoInput(rawItems: unknown): PageCategoryUndoRequest[] | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_PAGE_CATEGORY_MOVE_ITEMS) return null;
  const seen = new Set<string>();
  const items: PageCategoryUndoRequest[] = [];
  for (const value of rawItems) {
    if (!value || typeof value !== "object") return null;
    const slug = parseSlug((value as { slug?: unknown }).slug);
    const expectedVersion = parseExpectedVersion((value as { expectedVersion?: unknown }).expectedVersion);
    const originalCategory = parseOriginalCategory((value as { originalCategory?: unknown }).originalCategory);
    if (!slug || expectedVersion === null || originalCategory === undefined || seen.has(slug)) return null;
    seen.add(slug);
    items.push({ slug, expectedVersion, originalCategory });
  }
  return items;
}

async function assertEditor(tx: ContentTransaction, wikiId: string, userId: string): Promise<void> {
  // membership downgrade/delete와 wiki trash가 검증 직후 경합하지 않도록 둘 다 commit까지 share-lock한다.
  const rows = await tx.$queryRawUnsafe<Array<{ role: "owner" | "editor" | "viewer" }>>(
    `SELECT m.role
       FROM "Wiki" w
       JOIN "Membership" m ON m."wikiId" = w.id
      WHERE w.id = $1 AND w."trashedAt" IS NULL AND m."userId" = $2
      FOR SHARE OF w, m`,
    wikiId,
    userId,
  );
  const role = rows[0]?.role;
  if (role !== "owner" && role !== "editor") throw new PageCategoryMoveError("forbidden");
}

/**
 * DnD/선택 이동은 UI에 실제로 보이는 folder ancestor 또는 현재 사용자의 고정 폴더만 받는다.
 * 단건 경로 입력 모달은 별도 allowNewCategory 경계로 새 폴더 생성을 계속 지원한다.
 */
async function assertExistingCategoryTarget(
  tx: ContentTransaction,
  wikiId: string,
  userId: string,
  category: string | null,
): Promise<void> {
  if (category === null) return;
  const [usedCategories, pinned] = await Promise.all([
    tx.page.findMany({
      where: {
        wikiId,
        archivedAt: null,
        trashedAt: null,
        category: { not: null },
        kind: { not: "note" },
      },
      select: { category: true },
      distinct: ["category"],
    }),
    tx.folderPin.findUnique({
      where: { userId_wikiId_category: { userId, wikiId, category } },
      select: { id: true },
    }),
  ]);
  if (pinned) return;
  const visible = usedCategories.some((row) => {
    const normalized = row.category?.split("/").map((part) => part.trim()).filter(Boolean).join("/");
    return normalized === category || normalized?.startsWith(`${category}/`) === true;
  });
  if (!visible) throw new PageCategoryMoveError("invalidTarget");
}

type MovePageRow = {
  id: string;
  slug: string;
  kind: "note" | "concept" | "entity" | "document" | "meta" | "personal";
  origin: "human" | "generated" | "mixed" | "system";
  sourceId: string | null;
  category: string | null;
  currentVersion: number;
  archivedAt: Date | null;
  trashedAt: Date | null;
};

async function loadAndValidatePages(
  tx: ContentTransaction,
  wikiId: string,
  items: readonly PageCategoryMoveRequest[],
): Promise<Map<string, MovePageRow>> {
  const pages = await tx.page.findMany({
    where: { wikiId, slug: { in: items.map((item) => item.slug) } },
    select: {
      id: true,
      slug: true,
      kind: true,
      origin: true,
      sourceId: true,
      category: true,
      currentVersion: true,
      archivedAt: true,
      trashedAt: true,
    },
  });
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  for (const item of items) {
    const page = bySlug.get(item.slug);
    if (!page) throw new PageCategoryMoveError("notFound", item.slug);
    if (page.currentVersion !== item.expectedVersion) {
      throw new PageCategoryMoveError("versionConflict", item.slug, page.currentVersion);
    }
    if (page.archivedAt || page.trashedAt || !isPageMoveEligible(page)) {
      throw new PageCategoryMoveError("notMovable", item.slug);
    }
  }
  return bySlug;
}

/** 모든 항목을 먼저 검증한 뒤 같은 wiki exclusive transaction 안에서 실제 변경분만 쓴다. */
export async function movePagesToCategory(input: {
  wikiId: string;
  userId: string;
  items: unknown;
  category: unknown;
  /** 기존 단건 경로 입력 모달에서만 true. Bulk/DnD 호출자가 지정하게 노출하지 않는다. */
  allowNewCategory?: boolean;
}): Promise<PageCategoryMoveResult> {
  const parsed = parsePageCategoryMoveInput(input.items, input.category);
  if (!parsed) throw new PageCategoryMoveError("invalidInput");
  if (
    input.allowNewCategory &&
    parsed.category !== null &&
    sanitizeCategorySlug(parsed.category) !== parsed.category
  ) {
    throw new PageCategoryMoveError("invalidInput");
  }
  return withModelPolicyWriteLock(input.wikiId, async (tx) => {
    await assertEditor(tx, input.wikiId, input.userId);
    if (!input.allowNewCategory) {
      await assertExistingCategoryTarget(tx, input.wikiId, input.userId, parsed.category);
    }
    const pages = await loadAndValidatePages(tx, input.wikiId, parsed.items);
    const moved: PageCategoryMoveReceipt[] = [];
    for (const item of parsed.items) {
      const page = pages.get(item.slug)!;
      if (page.category === parsed.category) continue;
      const result = await updatePageSnapshotTx(tx, {
        wikiId: input.wikiId,
        pageId: page.id,
        expectedVersion: item.expectedVersion,
        changes: { category: parsed.category },
        context: { actor: "human", userId: input.userId, reason: PAGE_CATEGORY_MOVE_REASON },
      });
      moved.push({
        slug: item.slug,
        originalCategory: page.category,
        category: parsed.category,
        newVersion: result.page.currentVersion,
      });
    }
    return { moved };
  });
}

/** 이동 직후 받은 version과 각 직전 revision의 category를 검증해 전부 또는 전무로 되돌린다. */
export async function restorePageCategories(input: {
  wikiId: string;
  userId: string;
  items: unknown;
}): Promise<PageCategoryMoveResult> {
  const items = parsePageCategoryUndoInput(input.items);
  if (!items) throw new PageCategoryMoveError("invalidInput");
  return withModelPolicyWriteLock(input.wikiId, async (tx) => {
    await assertEditor(tx, input.wikiId, input.userId);
    const pages = await loadAndValidatePages(tx, input.wikiId, items);
    const revisions = await tx.pageRevision.findMany({
      where: {
        OR: items.flatMap((item) => {
          const page = pages.get(item.slug)!;
          return [
            { pageId: page.id, version: item.expectedVersion },
            { pageId: page.id, version: item.expectedVersion - 1 },
          ];
        }),
      },
      select: { pageId: true, version: true, category: true, actor: true, userId: true, reason: true },
    });
    const revisionByKey = new Map(revisions.map((revision) => [`${revision.pageId}:${revision.version}`, revision]));
    for (const item of items) {
      const page = pages.get(item.slug)!;
      const currentRevision = revisionByKey.get(`${page.id}:${item.expectedVersion}`);
      const previousRevision = revisionByKey.get(`${page.id}:${item.expectedVersion - 1}`);
      if (
        !currentRevision ||
        !previousRevision ||
        currentRevision.actor !== "human" ||
        currentRevision.userId !== input.userId ||
        currentRevision.reason !== PAGE_CATEGORY_MOVE_REASON ||
        currentRevision.category !== page.category ||
        previousRevision.category !== item.originalCategory ||
        page.category === item.originalCategory
      ) {
        throw new PageCategoryMoveError("invalidUndo", item.slug);
      }
    }

    const moved: PageCategoryMoveReceipt[] = [];
    for (const item of items) {
      const page = pages.get(item.slug)!;
      const result = await updatePageSnapshotTx(tx, {
        wikiId: input.wikiId,
        pageId: page.id,
        expectedVersion: item.expectedVersion,
        changes: { category: item.originalCategory },
        context: { actor: "human", userId: input.userId, reason: PAGE_CATEGORY_UNDO_REASON },
      });
      moved.push({
        slug: item.slug,
        originalCategory: page.category,
        category: item.originalCategory,
        newVersion: result.page.currentVersion,
      });
    }
    return { moved };
  });
}

/** DB commit 이후의 비권위적 검색 projection 정리. 실패해도 이미 끝난 이동은 성공이다. */
export async function refreshPageCategoryMoveProjection(
  wikiId: string,
  moved: readonly PageCategoryMoveReceipt[],
): Promise<void> {
  if (moved.length === 0) return;
  await refreshCategorySearchProjection(
    wikiId,
    moved.flatMap((item) => [item.originalCategory, item.category]),
  );
}
