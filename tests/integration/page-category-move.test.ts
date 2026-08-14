import assert from "node:assert/strict";
import { test } from "node:test";

function assertIsolatedLocalDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("integration test requires explicit DATABASE_URL");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error(`integration test refuses non-local DB host: ${url.hostname}`);
  }
  if (process.env.JIMI_INTEGRATION_CONFIRM !== "ISOLATED-DB") {
    throw new Error("integration test requires JIMI_INTEGRATION_CONFIRM=ISOLATED-DB");
  }
}

test("page category batch move and heterogeneous undo are atomic, authorized, and revisioned", async () => {
  assertIsolatedLocalDatabase();
  const [{ prisma }, content, move] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/content-store"),
    import("../../src/lib/page-category-move"),
  ]);

  const expectCode = async (promise: Promise<unknown>, code: string) => {
    await assert.rejects(promise, (error: unknown) =>
      error instanceof move.PageCategoryMoveError && error.code === code,
    );
  };

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const [owner, editor, viewer, outsider] = await Promise.all([
      prisma.user.create({ data: { email: "category-move-owner@example.invalid", emailVerified: new Date() } }),
      prisma.user.create({ data: { email: "category-move-editor@example.invalid", emailVerified: new Date() } }),
      prisma.user.create({ data: { email: "category-move-viewer@example.invalid", emailVerified: new Date() } }),
      prisma.user.create({ data: { email: "category-move-outsider@example.invalid", emailVerified: new Date() } }),
    ]);
    const wiki = await prisma.wiki.create({
      data: {
        slug: "category-move-integration",
        title: "Category move integration",
        kind: "project",
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "owner" },
            { userId: editor.id, role: "editor" },
            { userId: viewer.id, role: "viewer" },
          ],
        },
      },
    });
    const otherWiki = await prisma.wiki.create({
      data: {
        slug: "category-move-other",
        title: "Category move other",
        kind: "project",
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: "owner" } },
      },
    });
    const makePage = async (slug: string, category: string | null) => content.createPageSnapshot({
      wikiId: wiki.id,
      slug,
      title: slug,
      body: `${slug} body`,
      kind: "concept",
      category,
      context: { actor: "human", userId: owner.id },
    });

    // Bulk/DnD target은 현재 TOC에 보이는 category ancestor여야 한다.
    for (const [slug, category] of [
      ["target-seed-new-single", "new/single"],
      ["target-seed-legacy", "Legacy Target"],
      ["target-seed-bundle", "bundle"],
      ["target-seed-rollback", "rollback-target"],
      ["target-seed-undo", "undo-target"],
      ["target-seed-forged", "forged"],
      ["target-seed-must-rollback", "must-rollback"],
    ] as const) {
      await makePage(slug, category);
    }

    const single = await makePage("single", "old/single");
    const singleResult = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: "single", expectedVersion: 1 }],
      category: "new/single",
    });
    assert.deepEqual(singleResult.moved, [{
      slug: "single",
      originalCategory: "old/single",
      category: "new/single",
      newVersion: 2,
    }]);
    const singleAfter = await prisma.page.findUniqueOrThrow({ where: { id: single.page.id } });
    assert.equal(singleAfter.category, "new/single");
    assert.equal(singleAfter.currentVersion, 2);
    assert.equal((await prisma.pageRevision.findUniqueOrThrow({
      where: { pageId_version: { pageId: single.page.id, version: 2 } },
    })).reason, move.PAGE_CATEGORY_MOVE_REASON);

    const legacyTargetPage = await makePage("legacy-target-page", "legacy/source");
    const legacyTargetResult = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: legacyTargetPage.page.slug, expectedVersion: 1 }],
      category: "Legacy Target",
    });
    assert.deepEqual(legacyTargetResult.moved.map((item) => [item.slug, item.category, item.newVersion]), [
      ["legacy-target-page", "Legacy Target", 2],
    ]);

    const [multiA, multiB] = await Promise.all([makePage("multi-a", "old/a"), makePage("multi-b", null)]);
    const multiResult = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: [
        { slug: multiA.page.slug, expectedVersion: 1 },
        { slug: multiB.page.slug, expectedVersion: 1 },
      ],
      category: "bundle",
    });
    assert.deepEqual(multiResult.moved.map((item) => [item.slug, item.originalCategory, item.newVersion]), [
      ["multi-a", "old/a", 2],
      ["multi-b", null, 2],
    ]);
    const undoResult = await move.restorePageCategories({
      wikiId: wiki.id,
      userId: owner.id,
      items: multiResult.moved.map((item) => ({
        slug: item.slug,
        expectedVersion: item.newVersion,
        originalCategory: item.originalCategory,
      })),
    });
    assert.deepEqual(undoResult.moved.map((item) => [item.slug, item.category, item.newVersion]), [
      ["multi-a", "old/a", 3],
      ["multi-b", null, 3],
    ]);

    const [same, changed] = await Promise.all([makePage("same", "target"), makePage("changed", "elsewhere")]);
    const exactNoop = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: same.page.slug, expectedVersion: 1 }],
      category: "target",
    });
    assert.deepEqual(exactNoop.moved, []);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: same.page.id } })).currentVersion, 1);
    assert.equal(await prisma.pageRevision.count({ where: { pageId: same.page.id } }), 1);

    const mixedNoop = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [
        { slug: same.page.slug, expectedVersion: 1 },
        { slug: changed.page.slug, expectedVersion: 1 },
      ],
      category: "target",
    });
    assert.deepEqual(mixedNoop.moved.map((item) => item.slug), ["changed"]);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: same.page.id } })).currentVersion, 1);
    assert.equal(await prisma.pageRevision.count({ where: { pageId: same.page.id } }), 1);

    const [noopBeforeStale, stale] = await Promise.all([
      makePage("noop-before-stale", "target"),
      makePage("stale", "old"),
    ]);
    await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: stale.page.id,
      expectedVersion: 1,
      changes: { body: "edited after selection" },
      context: { actor: "human", userId: editor.id },
    });
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [
        { slug: noopBeforeStale.page.slug, expectedVersion: 1 },
        { slug: stale.page.slug, expectedVersion: 1 },
      ],
      category: "target",
    }), "versionConflict");
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: noopBeforeStale.page.id } })).currentVersion, 1);
    assert.equal(await prisma.pageRevision.count({ where: { pageId: noopBeforeStale.page.id } }), 1);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: stale.page.id } })).category, "old");

    const [rollbackA, rollbackB] = await Promise.all([makePage("rollback-a", "a"), makePage("rollback-b", "b")]);
    await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: rollbackB.page.id,
      expectedVersion: 1,
      changes: { body: "stale b" },
      context: { actor: "human", userId: owner.id },
    });
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: [
        { slug: rollbackA.page.slug, expectedVersion: 1 },
        { slug: rollbackB.page.slug, expectedVersion: 1 },
      ],
      category: "rollback-target",
    }), "versionConflict");
    assert.deepEqual(await prisma.page.findUniqueOrThrow({ where: { id: rollbackA.page.id } }).then((page) => [page.category, page.currentVersion]), ["a", 1]);
    assert.equal(await prisma.pageRevision.count({ where: { pageId: rollbackA.page.id } }), 1);

    const [undoStaleA, undoStaleB] = await Promise.all([makePage("undo-stale-a", "ua"), makePage("undo-stale-b", "ub")]);
    const undoStaleMove = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: [
        { slug: undoStaleA.page.slug, expectedVersion: 1 },
        { slug: undoStaleB.page.slug, expectedVersion: 1 },
      ],
      category: "undo-target",
    });
    await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: undoStaleA.page.id,
      expectedVersion: 2,
      changes: { body: "edited after move" },
      context: { actor: "human", userId: owner.id },
    });
    await expectCode(move.restorePageCategories({
      wikiId: wiki.id,
      userId: owner.id,
      items: undoStaleMove.moved.map((item) => ({
        slug: item.slug,
        expectedVersion: item.newVersion,
        originalCategory: item.originalCategory,
      })),
    }), "versionConflict");
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: undoStaleA.page.id } })).category, "undo-target");
    assert.deepEqual(await prisma.page.findUniqueOrThrow({ where: { id: undoStaleB.page.id } }).then((page) => [page.category, page.currentVersion]), ["undo-target", 2]);

    const guarded = await makePage("guarded", "guard-old");
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: guarded.page.slug, expectedVersion: 1 }],
      category: "invented/by-client",
    }), "invalidTarget");
    assert.deepEqual(await prisma.page.findUniqueOrThrow({ where: { id: guarded.page.id } }).then((page) => [page.category, page.currentVersion]), ["guard-old", 1]);

    await prisma.folderPin.create({
      data: { userId: editor.id, wikiId: wiki.id, category: "empty/pinned" },
    });
    const pinnedTargetResult = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: guarded.page.slug, expectedVersion: 1 }],
      category: "empty/pinned",
    });
    assert.deepEqual(pinnedTargetResult.moved.map((item) => [item.slug, item.category, item.newVersion]), [
      ["guarded", "empty/pinned", 2],
    ]);

    const modalPath = await makePage("modal-new-path", "modal-old");
    const modalPathResult = await move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: modalPath.page.slug, expectedVersion: 1 }],
      category: "modal/new-path",
      allowNewCategory: true,
    });
    assert.equal(modalPathResult.moved[0]?.category, "modal/new-path");
    const malformedNewPath = await makePage("modal-malformed-path", "modal-old");
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: editor.id,
      items: [{ slug: malformedNewPath.page.slug, expectedVersion: 1 }],
      category: "Modal New Path",
      allowNewCategory: true,
    }), "invalidInput");
    assert.deepEqual(
      await prisma.page.findUniqueOrThrow({ where: { id: malformedNewPath.page.id } })
        .then((page) => [page.category, page.currentVersion]),
      ["modal-old", 1],
    );

    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: viewer.id,
      items: [{ slug: guarded.page.slug, expectedVersion: 2 }],
      category: "guard-new",
    }), "forbidden");
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: outsider.id,
      items: [{ slug: guarded.page.slug, expectedVersion: 2 }],
      category: "guard-new",
    }), "forbidden");
    assert.deepEqual(await prisma.page.findUniqueOrThrow({ where: { id: guarded.page.id } }).then((page) => [page.category, page.currentVersion]), ["empty/pinned", 2]);

    await content.createPageSnapshot({
      wikiId: otherWiki.id,
      slug: "other-only",
      title: "other only",
      kind: "concept",
      category: "other",
      context: { actor: "human", userId: owner.id },
    });
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: [{ slug: "other-only", expectedVersion: 1 }],
      category: "forged",
    }), "notFound");

    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: [
        { slug: guarded.page.slug, expectedVersion: 1 },
        { slug: guarded.page.slug, expectedVersion: 1 },
      ],
      category: null,
    }), "invalidInput");
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: Array.from({ length: move.MAX_PAGE_CATEGORY_MOVE_ITEMS + 1 }, (_, index) => ({
        slug: `oversized-${index}`,
        expectedVersion: 1,
      })),
      category: null,
    }), "invalidInput");
    await expectCode(move.movePagesToCategory({
      wikiId: wiki.id,
      userId: owner.id,
      items: [{ slug: guarded.page.slug, expectedVersion: 1 }],
      category: { path: "forged" },
    }), "invalidInput");

    const system = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "system-projection",
      title: "system projection",
      kind: "meta",
      origin: "system",
      context: { actor: "system" },
    });
    const reserved = await prisma.page.create({
      data: { wikiId: wiki.id, slug: "settings", title: "reserved", kind: "concept" },
    });
    const source = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "source",
      title: "source",
      body: "source body",
      context: { actor: "human", userId: owner.id },
    });
    const sourceNote = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "source-note",
      title: "source note",
      kind: "note",
      sourceId: source.source.id,
      sourceRevisionIds: [source.revision.id],
      context: { actor: "agent", userId: owner.id },
    });
    const archived = await makePage("archived", "archive-old");
    const archivedResult = await content.archivePageSnapshot({
      wikiId: wiki.id,
      pageId: archived.page.id,
      expectedVersion: 1,
      context: { actor: "human", userId: owner.id },
    });
    const trashed = await makePage("trashed", "trash-old");
    const trashedPage = await prisma.page.update({
      where: { id: trashed.page.id },
      data: { trashedAt: new Date() },
    });
    for (const ineligible of [system.page, reserved, sourceNote.page, archivedResult.page, trashedPage]) {
      await expectCode(move.movePagesToCategory({
        wikiId: wiki.id,
        userId: owner.id,
        items: [
          { slug: guarded.page.slug, expectedVersion: 2 },
          { slug: ineligible.slug, expectedVersion: ineligible.currentVersion },
        ],
        category: "must-rollback",
      }), "notMovable");
      assert.deepEqual(await prisma.page.findUniqueOrThrow({ where: { id: guarded.page.id } }).then((page) => [page.category, page.currentVersion]), ["empty/pinned", 2]);
      assert.equal(await prisma.pageRevision.count({ where: { pageId: guarded.page.id } }), 2);
    }
  } finally {
    await prisma.$disconnect();
  }
});
