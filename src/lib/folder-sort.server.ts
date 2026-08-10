import "server-only";
import { prisma } from "@/lib/db";
import { sanitizeCategorySlug } from "@/lib/ontology";
import {
  categoryIsInSubtree,
  isFolderSortSelection,
  type FolderSortMode,
  type FolderSortSelection,
} from "@/lib/folder-sort";
import type { Prisma } from "@/generated/prisma/client";

export async function listFolderSortPreferences(
  userId: string,
  wikiId: string,
): Promise<Map<string, FolderSortMode>> {
  const rows = await prisma.folderSortPreference.findMany({
    where: { userId, wikiId },
    select: { category: true, mode: true },
  });
  return new Map(rows.map((row) => [row.category, row.mode]));
}

export async function getFolderSortPreference(
  userId: string,
  wikiId: string,
  category: string,
): Promise<FolderSortMode | null> {
  const row = await prisma.folderSortPreference.findUnique({
    where: { userId_wikiId_category: { userId, wikiId, category } },
    select: { mode: true },
  });
  return row?.mode ?? null;
}

async function assertMemberFolder(userId: string, wikiId: string, category: string): Promise<void> {
  const [membership, categoryRows] = await Promise.all([
    prisma.membership.findUnique({
      where: { wikiId_userId: { wikiId, userId } },
      select: { id: true },
    }),
    prisma.page.findMany({
      where: {
        wikiId,
        archivedAt: null,
        trashedAt: null,
        category: { not: null },
        OR: [{ category }, { category: { startsWith: `${category}/` } }],
      },
      select: { category: true },
      distinct: ["category"],
    }),
  ]);
  if (!membership) throw new Error("접근 권한이 없습니다");
  if (!categoryRows.some((row) => categoryIsInSubtree(row.category, category))) {
    throw new Error("존재하지 않는 폴더입니다");
  }
}

/** viewer를 포함한 멤버 개인 설정. Auto는 별도 enum 값이 아니라 행 부재로 표현한다. */
export async function saveFolderSortPreference(
  userId: string,
  wikiId: string,
  rawCategory: string,
  rawSelection: unknown,
): Promise<FolderSortSelection> {
  if (!isFolderSortSelection(rawSelection)) throw new Error("유효하지 않은 정렬 방식입니다");
  const category = rawCategory.trim();
  if (!category || sanitizeCategorySlug(category) !== category) {
    throw new Error("유효하지 않은 폴더 경로입니다");
  }
  await assertMemberFolder(userId, wikiId, category);

  if (rawSelection === "auto") {
    await prisma.folderSortPreference.deleteMany({ where: { userId, wikiId, category } });
    return rawSelection;
  }
  await prisma.folderSortPreference.upsert({
    where: { userId_wikiId_category: { userId, wikiId, category } },
    update: { mode: rawSelection },
    create: { userId, wikiId, category, mode: rawSelection },
  });
  return rawSelection;
}

/** Page category 이동과 같은 transaction 안에서 모든 사용자의 subtree 설정을 재키잉한다. */
export async function relocateFolderSortPreferencesTx(
  tx: Prisma.TransactionClient,
  wikiId: string,
  from: string,
  to: string | null,
): Promise<void> {
  const rows = await tx.folderSortPreference.findMany({
    // startsWith는 `_` 등을 LIKE wildcard로 취급할 수 있으므로 후보만 줄이고 아래에서 경계를 재확인한다.
    where: { wikiId, OR: [{ category: from }, { category: { startsWith: `${from}/` } }] },
    select: { id: true, userId: true, category: true, mode: true },
  });
  const moving = rows.filter((row) => categoryIsInSubtree(row.category, from));
  if (moving.length === 0) return;

  await tx.folderSortPreference.deleteMany({ where: { id: { in: moving.map((row) => row.id) } } });
  if (to === null) return;

  for (const row of moving) {
    const category = row.category === from ? to : `${to}${row.category.slice(from.length)}`;
    await tx.folderSortPreference.upsert({
      where: { userId_wikiId_category: { userId: row.userId, wikiId, category } },
      update: {}, // 이미 있던 대상 폴더 설정 우선
      create: { userId: row.userId, wikiId, category, mode: row.mode },
    });
  }
}
