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

test("folder sort preferences persist per member and follow category lifecycle", async () => {
  assertIsolatedLocalDatabase();
  const [{ prisma }, folderSort, governance, ontology, content] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/folder-sort.server"),
    import("../../src/lib/governance"),
    import("../../src/lib/ontology"),
    import("../../src/lib/content-store"),
  ]);

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const owner = await prisma.user.create({ data: { email: "folder-sort-owner@example.invalid", emailVerified: new Date() } });
    const viewer = await prisma.user.create({ data: { email: "folder-sort-viewer@example.invalid", emailVerified: new Date() } });
    const outsider = await prisma.user.create({ data: { email: "folder-sort-outsider@example.invalid", emailVerified: new Date() } });
    const wiki = await prisma.wiki.create({
      data: {
        slug: "folder-sort-wiki",
        title: "Folder sort wiki",
        kind: "project",
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "owner" },
            { userId: viewer.id, role: "viewer" },
          ],
        },
      },
    });
    const otherWiki = await prisma.wiki.create({
      data: {
        slug: "folder-sort-other",
        title: "Other wiki",
        kind: "personal",
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: "owner" } },
      },
    });
    await prisma.page.createMany({
      data: [
        { wikiId: wiki.id, slug: "prefs-page", title: "Prefs", kind: "concept", category: "prefs/sub" },
        { wikiId: otherWiki.id, slug: "prefs-page", title: "Prefs", kind: "concept", category: "prefs/sub" },
      ],
    });

    // viewer도 자기 설정을 저장하며 같은 category의 다른 사용자·위키 행과 격리된다.
    assert.equal(await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "prefs", "newest"), "newest");
    await folderSort.saveFolderSortPreference(owner.id, wiki.id, "prefs", "title");
    await folderSort.saveFolderSortPreference(owner.id, otherWiki.id, "prefs", "oldest");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "prefs", "oldest");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "prefs"), "oldest", "upsert updates one personal row");
    assert.equal(await folderSort.getFolderSortPreference(owner.id, wiki.id, "prefs"), "title");
    assert.equal(await folderSort.getFolderSortPreference(owner.id, otherWiki.id, "prefs"), "oldest");

    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "prefs", "auto");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "prefs"), null, "Auto deletes the override row");
    assert.equal(await folderSort.getFolderSortPreference(owner.id, wiki.id, "prefs"), "title");

    const beforeInvalid = await prisma.folderSortPreference.count();
    await assert.rejects(folderSort.saveFolderSortPreference(viewer.id, wiki.id, "prefs", "sideways"), /유효하지 않은 정렬/);
    await assert.rejects(folderSort.saveFolderSortPreference(viewer.id, wiki.id, "", "newest"), /유효하지 않은 폴더/);
    await assert.rejects(folderSort.saveFolderSortPreference(viewer.id, wiki.id, "prefs//sub", "newest"), /유효하지 않은 폴더/);
    await assert.rejects(folderSort.saveFolderSortPreference(viewer.id, wiki.id, "missing", "newest"), /존재하지 않는 폴더/);
    await assert.rejects(folderSort.saveFolderSortPreference(outsider.id, wiki.id, "prefs", "newest"), /접근 권한/);
    assert.equal(await prisma.folderSortPreference.count(), beforeInvalid, "invalid writes leave all preference rows unchanged");

    const lifecycleCategories = [
      "old",
      "old/child",
      "source",
      "source/child",
      "target",
      "target/child",
      "retire",
      "retire/child",
      "gpt_4",
      "gptx4",
    ];
    for (const [index, category] of lifecycleCategories.entries()) {
      await content.createPageSnapshot({
        wikiId: wiki.id,
        slug: `lifecycle-${index}`,
        title: category,
        body: "",
        kind: "concept",
        category,
        modelAccess: "internalOnly",
        context: { actor: "human", userId: owner.id },
      });
    }
    await ontology.setOntology(wiki.id, (doc) => ({
      ...doc,
      categories: lifecycleCategories.map((slug) => ({ slug, label: slug.split("/").pop() ?? slug })),
    }));

    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "old", "newest");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "old/child", "oldest");
    await governance.renameCategory(wiki.id, "old", "renamed");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "old"), null);
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "renamed"), "newest");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "renamed/child"), "oldest");

    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "source", "newest");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "source/child", "oldest");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "target", "title");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "target/child", "newest");
    await folderSort.saveFolderSortPreference(owner.id, wiki.id, "source", "oldest");
    await governance.mergeCategory(wiki.id, "source", "target");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "source"), null);
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "target"), "title", "existing target wins exact collision");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "target/child"), "newest", "existing target wins descendant collision");
    assert.equal(await folderSort.getFolderSortPreference(owner.id, wiki.id, "target"), "oldest", "other users move independently");

    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "retire", "newest");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "retire/child", "oldest");
    await governance.retireCategory(wiki.id, "retire");
    assert.equal(await prisma.folderSortPreference.count({ where: { wikiId: wiki.id, userId: viewer.id, category: { startsWith: "retire" } } }), 0);

    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "gpt_4", "oldest");
    await folderSort.saveFolderSortPreference(viewer.id, wiki.id, "gptx4", "title");
    await governance.renameCategory(wiki.id, "gpt_4", "gpt-four");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "gpt-four"), "oldest");
    assert.equal(await folderSort.getFolderSortPreference(viewer.id, wiki.id, "gptx4"), "title", "underscore path does not match a sibling");
    assert.equal((await prisma.page.findFirstOrThrow({ where: { wikiId: wiki.id, category: "gptx4" } })).category, "gptx4");
  } finally {
    await prisma.$disconnect();
  }
});
