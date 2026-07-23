import "server-only";
import { prisma } from "@/lib/db";
import { extractWikiTargets } from "@/lib/markdown";
import { reindexPage, reindexSource } from "@/lib/search";
import type { Prisma } from "@/generated/prisma/client";
import { withModelPolicyWriteLock } from "@/lib/model-access";

/** Page revision projection에서 링크·로컬 FTS projection을 재생성한다. */
export async function refreshPageDerivedState(wikiId: string, pageId: string): Promise<void> {
  // PageLink의 unresolved-target 해소와 from-page 재생성을 서로 다른 페이지에서 동시에 하면
  // 동일 PageLink 행을 반대 순서로 잠가 deadlock이 날 수 있다. wiki 단위 write lock으로 projection을 직렬화한다.
  const page = await withModelPolicyWriteLock(wikiId, async (tx) => {
    await tx.$executeRawUnsafe(
      'SELECT 1 FROM "Page" WHERE id=$1 AND "wikiId"=$2 FOR UPDATE',
      pageId,
      wikiId,
    );
    const current = await tx.page.findFirst({ where: { id: pageId, wikiId } });
    if (!current) {
      await tx.searchChunk.deleteMany({ where: { wikiId, refType: "page", refId: pageId } });
      return null;
    }
    if (current.archivedAt) {
      await tx.pageContribution.deleteMany({ where: { pageId: current.id } });
      await tx.pageLink.deleteMany({ where: { fromPageId: current.id } });
      await tx.pageLink.updateMany({ where: { wikiId, toPageId: current.id }, data: { toPageId: null } });
      await tx.searchChunk.deleteMany({ where: { wikiId, refType: "page", refId: current.id } });
      return current;
    }

    const currentRevision = await tx.pageRevision.findUnique({
      where: { pageId_version: { pageId: current.id, version: current.currentVersion } },
      select: { sources: { select: { sourceRevision: { select: { sourceId: true } } } } },
    });
    if (!currentRevision) throw new Error(`Page projection/current revision mismatch: ${current.id}@${current.currentVersion}`);
    const contributionSourceIds = [...new Set(currentRevision.sources.flatMap((source) =>
      source.sourceRevision ? [source.sourceRevision.sourceId] : []
    ))];
    const targets = extractWikiTargets(current.body);
    const resolved = targets.length
      ? await tx.page.findMany({
          where: { wikiId, slug: { in: targets }, archivedAt: null },
          select: { id: true, slug: true },
        })
      : [];
    const idBySlug = new Map(resolved.map((target) => [target.slug, target.id]));
    await tx.pageContribution.deleteMany({ where: { pageId: current.id } });
    if ((current.kind === "concept" || current.kind === "entity") && contributionSourceIds.length) {
      await tx.pageContribution.createMany({
        data: contributionSourceIds.map((sourceId) => ({ wikiId, pageId: current.id, sourceId })),
        skipDuplicates: true,
      });
    }
    await tx.pageLink.deleteMany({ where: { fromPageId: current.id } });
    if (targets.length) {
      await tx.pageLink.createMany({
        data: targets.map((target): Prisma.PageLinkCreateManyInput => ({
          wikiId,
          fromPageId: current.id,
          toSlug: target,
          toPageId: idBySlug.get(target) ?? null,
        })),
      });
    }
    await tx.pageLink.updateMany({
      where: { wikiId, toSlug: current.slug, toPageId: null },
      data: { toPageId: current.id },
    });
    return current;
  });
  if (!page || page.archivedAt) return;
  await reindexPage(wikiId, page);
}

export async function refreshSourceDerivedState(wikiId: string, sourceId: string): Promise<void> {
  const source = await prisma.source.findFirst({ where: { id: sourceId, wikiId } });
  if (!source) {
    await prisma.searchChunk.deleteMany({ where: { wikiId, refType: "source", refId: sourceId } });
    return;
  }
  await reindexSource(wikiId, { ...source, body: source.body ?? "" });
}

/** 게시/복원 후 현재 revision provenance에서 PageContribution projection을 정확히 재생성한다. */
export async function rebuildPageContributions(wikiId: string): Promise<void> {
  await withModelPolicyWriteLock(wikiId, async (tx) => {
    const pages = await tx.page.findMany({
      where: { wikiId, archivedAt: null, kind: { in: ["concept", "entity"] } },
      select: {
        id: true,
        currentVersion: true,
        revisions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true, sources: { select: { sourceRevision: { select: { sourceId: true } } } } },
        },
      },
    });
    const rows = pages.flatMap((page) => {
      const revision = page.revisions[0];
      if (!revision || revision.version !== page.currentVersion) return [];
      return [...new Set(revision.sources.flatMap((source) =>
        source.sourceRevision ? [source.sourceRevision.sourceId] : []
      ))].map((sourceId) => ({
        wikiId,
        pageId: page.id,
        sourceId,
      }));
    });
    await tx.pageContribution.deleteMany({ where: { wikiId } });
    if (rows.length) await tx.pageContribution.createMany({ data: rows, skipDuplicates: true });
  });
}
