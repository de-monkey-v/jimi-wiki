import assert from "node:assert/strict";
import { test } from "node:test";

function assertIsolatedLocalDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("integration test requires explicit DATABASE_URL");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error(`integration test refuses non-local DB host: ${url.hostname}`);
  if (process.env.JIMI_INTEGRATION_CONFIRM !== "ISOLATED-DB") {
    throw new Error("integration test requires JIMI_INTEGRATION_CONFIRM=ISOLATED-DB");
  }
}

test("14-day trash preserves revisions, source notes, saved links, and whole-wiki isolation", async () => {
  assertIsolatedLocalDatabase();
  const [{ prisma }, content, trash, savedLinks, wikiStore, ingest, keys, pageRoute, pageRestoreRoute, sourceRoute, sourceRestoreRoute, trashRoute] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/content-store"),
    import("../../src/lib/trash"),
    import("../../src/lib/saved-links"),
    import("../../src/lib/wiki"),
    import("../../src/lib/ingest"),
    import("../../src/lib/apikey"),
    import("../../src/app/api/wikis/[id]/pages/[pageSlug]/route"),
    import("../../src/app/api/wikis/[id]/pages/[pageSlug]/restore/route"),
    import("../../src/app/api/wikis/[id]/sources/[sourceSlug]/route"),
    import("../../src/app/api/wikis/[id]/sources/[sourceSlug]/restore/route"),
    import("../../src/app/api/wikis/[id]/trash/route"),
  ]);

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const user = await prisma.user.create({ data: { email: "trash-integration@example.invalid", emailVerified: new Date() } });
    const wiki = await prisma.wiki.create({
      data: {
        slug: "trash-integration",
        title: "Trash Integration",
        kind: "project",
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });
    const apiKey = await keys.createApiKey(user.id, "trash-key", { wikiId: wiki.id, maxRole: "editor" });
    const now = new Date("2026-07-22T00:00:00.000Z");
    const documentAt = new Date("2026-07-21T03:00:00.000Z");
    const document = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "trash-document",
      title: "Trash Document",
      body: "document body",
      kind: "document",
      documentType: "decision",
      documentAt,
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });

    const trashedDocument = await trash.trashPage({
      wikiId: wiki.id,
      pageId: document.page.id,
      expectedVersion: 1,
      userId: user.id,
      now,
    });
    assert.equal(trashedDocument.currentVersion, 2);
    assert.equal(trashedDocument.archivedAt?.toISOString(), now.toISOString());
    assert.equal(trashedDocument.trashedAt?.toISOString(), now.toISOString());
    assert.equal(trashedDocument.purgeAt?.getTime(), now.getTime() + trash.TRASH_RETENTION_MS);

    const restoredDocument = await trash.restoreTrashedPage({
      wikiId: wiki.id,
      pageId: document.page.id,
      expectedVersion: 2,
      userId: user.id,
    });
    assert.equal(restoredDocument.currentVersion, 3);
    assert.equal(restoredDocument.archivedAt, null);
    assert.equal(restoredDocument.trashedAt, null);
    assert.equal(restoredDocument.documentType, "decision");
    assert.equal(restoredDocument.documentAt?.toISOString(), documentAt.toISOString());
    const restoredRevision = await prisma.pageRevision.findUniqueOrThrow({
      where: { pageId_version: { pageId: document.page.id, version: 3 } },
    });
    assert.equal(restoredRevision.documentType, "decision");
    assert.equal(restoredRevision.documentAt?.toISOString(), documentAt.toISOString());

    const source = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "trash-source",
      title: "Trash Source",
      body: "immutable source",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const note = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "trash-source-note",
      title: "Trash Source Note",
      body: "source summary",
      kind: "note",
      sourceId: source.source.id,
      sourceRevisionIds: [source.revision.id],
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const trashedSource = await trash.trashSource({
      wikiId: wiki.id,
      sourceId: source.source.id,
      expectedVersion: 1,
      userId: user.id,
      now,
    });
    assert.equal(trashedSource.trashedAt?.toISOString(), now.toISOString());
    assert.ok((await prisma.page.findUniqueOrThrow({ where: { id: note.page.id } })).archivedAt);
    const restoredSource = await trash.restoreTrashedSource({
      wikiId: wiki.id,
      sourceId: source.source.id,
      expectedVersion: trashedSource.currentVersion,
      userId: user.id,
    });
    assert.equal(restoredSource.archivedAt, null);
    assert.equal(restoredSource.trashedAt, null);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: note.page.id } })).archivedAt, null);

    const link = await prisma.savedLink.create({
      data: { wikiId: wiki.id, userId: user.id, url: "https://example.com/read", title: "Read later" },
    });
    const trashedLink = await savedLinks.trashSavedLink(wiki.id, user.id, link.id, now);
    assert.equal(trashedLink.link.purgeAt?.getTime(), now.getTime() + trash.TRASH_RETENTION_MS);
    const restoredLink = await savedLinks.restoreSavedLink(wiki.id, user.id, link.id);
    assert.equal(restoredLink.restored, true);
    assert.equal(restoredLink.link.trashedAt, null);

    const externalPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "external-trash-page",
      title: "External Trash Page",
      body: "agent-visible body",
      kind: "concept",
      context: { actor: "human", userId: user.id },
    });
    const headers = { Authorization: `Bearer ${apiKey.token}`, "X-Jimi-Model-Trust": "external" };

    const hiddenPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "hidden-trash-page",
      title: "Never expose this title",
      body: "Never expose this body",
      kind: "document",
      documentType: "general",
      documentAt: now,
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const hiddenDelete = await pageRoute.DELETE(
      new Request(`http://localhost/api/wikis/${wiki.slug}/pages/${hiddenPage.page.slug}?expectedVersion=1`, { method: "DELETE", headers }),
      { params: Promise.resolve({ id: wiki.slug, pageSlug: hiddenPage.page.slug }) },
    );
    assert.equal(hiddenDelete.status, 404, "external agents must not trash internalOnly pages");
    await trash.trashPage({
      wikiId: wiki.id,
      pageId: hiddenPage.page.id,
      expectedVersion: 1,
      userId: user.id,
      now,
    });

    const pageDelete = await pageRoute.DELETE(
      new Request(`http://localhost/api/wikis/${wiki.slug}/pages/${externalPage.page.slug}?expectedVersion=1`, { method: "DELETE", headers }),
      { params: Promise.resolve({ id: wiki.slug, pageSlug: externalPage.page.slug }) },
    );
    assert.equal(pageDelete.status, 200);
    assert.equal((await pageDelete.json()).trashed, true);
    const trashList = await trashRoute.GET(
      new Request(`http://localhost/api/wikis/${wiki.slug}/trash`, { headers }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    assert.equal(trashList.status, 200);
    const trashBody = await trashList.json() as { pages: { slug: string; currentVersion: number }[] };
    assert.equal(trashBody.pages.some((page) => page.slug === hiddenPage.page.slug), false, "external trash list must hide internalOnly pages");
    const listedPage = trashBody.pages.find((page) => page.slug === externalPage.page.slug);
    assert.ok(listedPage);
    const pageRestore = await pageRestoreRoute.POST(
      new Request(`http://localhost/api/wikis/${wiki.slug}/pages/${externalPage.page.slug}/restore?expectedVersion=${listedPage.currentVersion}`, { method: "POST", headers }),
      { params: Promise.resolve({ id: wiki.slug, pageSlug: externalPage.page.slug }) },
    );
    assert.equal(pageRestore.status, 200);

    const externalSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "external-trash-source",
      title: "External Trash Source",
      body: "agent-visible source",
      context: { actor: "human", userId: user.id },
    });
    const sourceDelete = await sourceRoute.DELETE(
      new Request(`http://localhost/api/wikis/${wiki.slug}/sources/${externalSource.source.slug}?expectedVersion=1`, { method: "DELETE", headers }),
      { params: Promise.resolve({ id: wiki.slug, sourceSlug: externalSource.source.slug }) },
    );
    assert.equal(sourceDelete.status, 200);
    const sourceAfterTrash = await prisma.source.findUniqueOrThrow({ where: { id: externalSource.source.id } });
    const sourceRestore = await sourceRestoreRoute.POST(
      new Request(`http://localhost/api/wikis/${wiki.slug}/sources/${externalSource.source.slug}/restore?expectedVersion=${sourceAfterTrash.currentVersion}`, { method: "POST", headers }),
      { params: Promise.resolve({ id: wiki.slug, sourceSlug: externalSource.source.slug }) },
    );
    assert.equal(sourceRestore.status, 200);

    const pendingRun = await prisma.agentRun.create({ data: { wikiId: wiki.id, userId: user.id, type: "ingest", status: "pending", input: { text: "pending" } } });
    const trashedWiki = await trash.trashWiki({ wikiId: wiki.id, slug: wiki.slug, userId: user.id, now });
    assert.equal(trashedWiki.purgeAt?.getTime(), now.getTime() + trash.TRASH_RETENTION_MS);
    assert.equal(await wikiStore.getWikiForUser(user.id, wiki.slug), null, "trashed wiki must be 404-equivalent");
    assert.equal(await ingest.claimNextAgentRun(), null, "worker must not claim work from a trashed wiki");
    assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: pendingRun.id } })).status, "error");

    const restoredWiki = await trash.restoreTrashedWiki(wiki.id);
    assert.equal(restoredWiki.slug, wiki.slug);
    assert.equal(restoredWiki.trashedAt, null);
    assert.ok(await wikiStore.getWikiForUser(user.id, wiki.slug));
    assert.equal(await prisma.apiKey.count({ where: { id: apiKey.id, wikiId: wiki.id, revokedAt: null } }), 1);
    assert.equal(await trash.purgeTrashedWiki(wiki.id, new Date("2030-01-01T00:00:00.000Z"), true), null, "restored wiki must not be purged by a stale sweep");
    assert.ok(await wikiStore.getWikiForUser(user.id, wiki.slug));
  } finally {
    await prisma.$disconnect();
  }
});
