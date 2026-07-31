import assert from "node:assert/strict";
import { test } from "node:test";

function assertIsolatedLocalDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("integration test requires explicit DATABASE_URL");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`integration test refuses non-local DB host: ${url.hostname}`);
  }
  if (process.env.JIMI_INTEGRATION_CONFIRM !== "ISOLATED-DB") {
    throw new Error("integration test requires JIMI_INTEGRATION_CONFIRM=ISOLATED-DB");
  }
}

test("위키 카드 페이지 수는 활성 문서·지식만 포함한다", async () => {
  assertIsolatedLocalDatabase();
  const [{ prisma }, wikiStore, { ONTOLOGY_SLUG }] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/wiki"),
    import("../../src/lib/ontology"),
  ]);

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const owner = await prisma.user.create({
      data: { email: "wiki-count-owner@example.invalid", emailVerified: new Date() },
    });
    const viewer = await prisma.user.create({
      data: { email: "wiki-count-viewer@example.invalid", emailVerified: new Date() },
    });
    const wiki = await prisma.wiki.create({
      data: {
        slug: "wiki-count",
        title: "Wiki Count",
        kind: "personal",
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "owner" },
            { userId: viewer.id, role: "viewer" },
          ],
        },
      },
    });

    await prisma.page.createMany({
      data: [
        { wikiId: wiki.id, slug: "research", title: "Research", kind: "document", documentType: "research", documentAt: new Date() },
        { wikiId: wiki.id, slug: "concept", title: "Concept", kind: "concept" },
        { wikiId: wiki.id, slug: "entity", title: "Entity", kind: "entity" },
        { wikiId: wiki.id, slug: "meta", title: "Meta", kind: "meta" },
        { wikiId: wiki.id, slug: ONTOLOGY_SLUG, title: "Ontology", kind: "meta", origin: "system" },
        { wikiId: wiki.id, slug: "source-note", title: "Source note", kind: "note", origin: "generated" },
        { wikiId: wiki.id, slug: "private-note", title: "Private note", kind: "personal", modelAccess: "internalOnly" },
        { wikiId: wiki.id, slug: "archived-concept", title: "Archived", kind: "concept", archivedAt: new Date() },
      ],
    });

    const [owned, shared] = await Promise.all([
      wikiStore.listOwnedWikis(owner.id),
      wikiStore.listSharedWikis(viewer.id),
    ]);

    assert.equal(owned[0]?._count.pages, 4);
    assert.equal(shared[0]?._count.pages, 4);
  } finally {
    await prisma.$disconnect();
  }
});
