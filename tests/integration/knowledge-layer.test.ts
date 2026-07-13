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

async function assertCompletesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("revision, policy, staging publish, local/model search, restore and purge invariants", async () => {
  assertIsolatedLocalDatabase();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  const [{ prisma }, content, projections, search, policy, builds, artifacts, modelAccess, lint, ontology, promotion, promotionPolicy, contentApi, wikiStore, blob, blobPurge] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/content-store"),
    import("../../src/lib/page-projections"),
    import("../../src/lib/search"),
    import("../../src/lib/model-policy"),
    import("../../src/lib/builds"),
    import("../../src/lib/build-artifacts"),
    import("../../src/lib/model-access"),
    import("../../src/lib/lint"),
    import("../../src/lib/ontology"),
    import("../../src/lib/page-source-promotion.server"),
    import("../../src/lib/page-source-promotion"),
    import("../../src/lib/content-api"),
    import("../../src/lib/wiki"),
    import("../../src/lib/blob"),
    import("../../src/lib/blob-purge"),
  ]);

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const user = await prisma.user.create({
      data: { email: "integration-owner@example.invalid", isAdmin: true, emailVerified: new Date() },
    });
    const wiki = await prisma.wiki.create({
      data: {
        slug: "integration-knowledge-layer",
        title: "Integration Knowledge Layer",
        kind: "project",
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });

    const external = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "external-source",
      title: "External Source",
      body: "PUBLIC_LEDGER_TERM describes append-only revisions.",
      modelAccess: "external",
      context: { actor: "human", userId: user.id },
    });
    const internal = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "internal-source",
      title: "Internal Source",
      body: "JIMI_INTERNAL_CANARY_INTEGRATION_91Z fictional test value",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    assert.equal(external.source.currentVersion, 1);
    assert.equal(internal.source.modelAccess, "internalOnly");

    const internalNote = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "internal-note",
      title: "Internal Note",
      kind: "note",
      body: "JIMI_INTERNAL_CANARY_INTEGRATION_91Z fictional test value",
      modelAccess: "internalOnly",
      sourceId: internal.source.id,
      sourceRevisionIds: [internal.revision.id],
      context: { actor: "agent", userId: user.id },
    });
    const personal = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "personal",
      title: "Personal",
      kind: "personal",
      body: "PERSONAL_LOCAL_TERM",
      modelAccess: "external",
      context: { actor: "human", userId: user.id },
    });
    assert.equal(personal.page.modelAccess, "internalOnly");
    await Promise.all([
      projections.refreshSourceDerivedState(wiki.id, external.source.id),
      projections.refreshSourceDerivedState(wiki.id, internal.source.id),
      projections.refreshPageDerivedState(wiki.id, internalNote.page.id),
      projections.refreshPageDerivedState(wiki.id, personal.page.id),
    ]);

    // 회귀: shared policy-lock transaction 안에서 global Prisma를 다시 빌리면 pool(기본 10)을
    // 10개의 idle-in-transaction 연결이 점유하고 아래 동시 색인/중첩 검색이 영구 대기한다.
    await assertCompletesWithin(
      Promise.all(Array.from({ length: 16 }, () => search.reindexSource(wiki.id, {
        id: external.source.id,
        slug: external.source.slug,
        body: external.source.body ?? "",
      }))),
      15_000,
      "concurrent policy-locked reindex",
    );
    await assertCompletesWithin(
      Promise.all(Array.from({ length: 16 }, () =>
        modelAccess.withExternalModelDispatchLock(wiki.id, async (tx) => {
          assert.equal(modelAccess.modelPolicyClient(wiki.id), tx, "nested loader must reuse lock transaction");
          const [hits, pages] = await Promise.all([
            search.modelSearch({ trust: "external", wikiId: wiki.id, queryText: "PUBLIC_LEDGER_TERM", k: 4 }),
            modelAccess.listModelPages(wiki.id, modelAccess.EXTERNAL_MODEL_SCOPE),
          ]);
          assert.ok(hits.some((hit) => hit.refId === external.source.id));
          return pages.length;
        }))),
      15_000,
      "nested policy-lock model search",
    );
    const externalRequest = new Request("http://localhost/api/test", {
      headers: { "x-jimi-model-trust": "external" },
    });
    await assertCompletesWithin(
      Promise.all(Array.from({ length: 16 }, () =>
        contentApi.withExternalModelResponseScope(externalRequest, wiki.id, async (tx) => {
          assert.equal(modelAccess.modelPolicyClient(wiki.id), tx, "response scope must expose its transaction");
          return tx.page.count({ where: { wikiId: wiki.id } });
        }))),
      15_000,
      "concurrent external response scope",
    );
    await assert.rejects(
      modelAccess.withExternalModelDispatchLock(wiki.id, () =>
        modelAccess.withModelPolicyWriteLock(wiki.id, async () => undefined)),
      /cannot be upgraded to exclusive/,
    );

    const localCanary = await search.localFtsSearch(wiki.id, "JIMI_INTERNAL_CANARY_INTEGRATION_91Z", 10);
    const modelCanary = await search.modelSearch({ trust: "external", wikiId: wiki.id, queryText: "JIMI_INTERNAL_CANARY_INTEGRATION_91Z", k: 10 });
    assert.ok(localCanary.some((hit) => hit.refId === internalNote.page.id || hit.refId === internal.source.id));
    assert.equal(modelCanary.length, 0);
    const internalChunks = await prisma.searchChunk.findMany({
      where: { wikiId: wiki.id, modelAccess: "internalOnly" },
      select: { id: true },
    });
    assert.ok(internalChunks.length >= 2);
    const embeddedInternal = await prisma.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM "SearchChunk" WHERE "wikiId"=$1 AND "modelAccess"=\'internalOnly\' AND embedding IS NOT NULL',
      wiki.id,
    );
    assert.equal(embeddedInternal[0]?.n, 0);

    const internalCategoryPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "internal-category-canary",
      title: "JIMI_INTERNAL_CATEGORY_CANARY_7Q",
      kind: "concept",
      body: "JIMI_INTERNAL_CATEGORY_CANARY_7Q",
      category: "private/canary-7q",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const externalCategoryPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "public-category-page",
      title: "Public Category Page",
      kind: "concept",
      body: "PUBLIC_CATEGORY_TERM",
      category: "public/topic",
      modelAccess: "external",
      context: { actor: "human", userId: user.id },
    });
    await Promise.all([
      projections.refreshPageDerivedState(wiki.id, internalCategoryPage.page.id),
      projections.refreshPageDerivedState(wiki.id, externalCategoryPage.page.id),
    ]);
    await ontology.setOntology(wiki.id, (doc) => ({
      ...doc,
      categories: [
        { slug: "private/canary-7q", label: "JIMI_INTERNAL_CATEGORY_CANARY_7Q", synonyms: ["SECRET_SYNONYM_7Q"] },
        { slug: "public/topic", label: "Public topic" },
      ],
    }));
    const safeCategories = await modelAccess.listExternalModelCategories(wiki.id, modelAccess.EXTERNAL_MODEL_SCOPE);
    assert.deepEqual(safeCategories.map((category) => category.slug), ["public", "public/topic"]);
    assert.equal(
      await modelAccess.getModelPage(wiki.id, ontology.ONTOLOGY_SLUG, modelAccess.EXTERNAL_MODEL_SCOPE),
      null,
      "raw system ontology must not be exposed through model readPage",
    );
    const externalLint = await lint.lintWiki(wiki.id, { modelScope: modelAccess.EXTERNAL_MODEL_SCOPE });
    assert.doesNotMatch(JSON.stringify(externalLint), /JIMI_INTERNAL_CATEGORY_CANARY_7Q|SECRET_SYNONYM_7Q/);

    const human = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "revision-ledger",
      title: "Human Ledger",
      kind: "concept",
      body: "human base",
      modelAccess: "external",
      context: { actor: "human", userId: user.id },
    });

    const attachedInternalPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "internal-provenance-attachment",
      title: "Internal Provenance Attachment",
      kind: "concept",
      body: "ATTACHED_INTERNAL_LOCAL_TERM",
      context: { actor: "human", userId: user.id },
    });
    await projections.refreshPageDerivedState(wiki.id, attachedInternalPage.page.id);
    const seededAttachedVector = await prisma.$executeRawUnsafe(
      `UPDATE "SearchChunk"
       SET embedding = array_fill(0.01::real, ARRAY[768])::vector
       WHERE "wikiId"=$1 AND "refType"='page' AND "refId"=$2 AND "modelAccess"='external'`,
      wiki.id,
      attachedInternalPage.page.id,
    );
    assert.ok(seededAttachedVector >= 1, "provenance attachment must exercise an existing vector");
    await wikiStore.addPageSource(
      wiki.id,
      attachedInternalPage.page.slug,
      internal.source.id,
      user.id,
    );
    const strictAttachedPage = await prisma.page.findUniqueOrThrow({ where: { id: attachedInternalPage.page.id } });
    assert.equal(strictAttachedPage.modelAccess, "internalOnly");
    assert.equal(strictAttachedPage.currentVersion, 2);
    const strictAttachedChunks = await prisma.$queryRawUnsafe<{ n: number; leaked: number }[]>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE "modelAccess" <> 'internalOnly' OR embedding IS NOT NULL)::int AS leaked
       FROM "SearchChunk"
       WHERE "wikiId"=$1 AND "refType"='page' AND "refId"=$2`,
      wiki.id,
      attachedInternalPage.page.id,
    );
    assert.ok((strictAttachedChunks[0]?.n ?? 0) >= 1);
    assert.equal(strictAttachedChunks[0]?.leaked, 0, "provenance strict-down must clear vectors atomically");
    assert.ok((await search.localFtsSearch(wiki.id, "ATTACHED_INTERNAL_LOCAL_TERM", 5))
      .some((hit) => hit.refId === attachedInternalPage.page.id));
    assert.equal((await search.modelSearch({
      trust: "external",
      wikiId: wiki.id,
      queryText: "ATTACHED_INTERNAL_LOCAL_TERM",
      k: 5,
    })).length, 0);

    const restoreSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "atomic-source-restore",
      title: "Atomic Source Restore",
      body: "source body v1",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const restoreSourceV2 = await content.updateSourceSnapshot({
      wikiId: wiki.id,
      sourceId: restoreSource.source.id,
      expectedVersion: restoreSource.source.currentVersion,
      changes: { body: "source body v2" },
      context: { actor: "human", userId: user.id },
    });
    const restoreDependent = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "atomic-source-restore-dependent",
      title: "Atomic Source Restore Dependent",
      kind: "concept",
      body: "page synthesized from source v2",
      origin: "generated",
      modelAccess: "internalOnly",
      sourceRevisionIds: [restoreSourceV2.revision.id],
      context: { actor: "agent" },
    });
    const atomicRestore = await policy.restoreSourceRevisionWithPropagation({
      wikiId: wiki.id,
      sourceId: restoreSource.source.id,
      expectedVersion: restoreSourceV2.source.currentVersion,
      revisionId: restoreSource.revision.id,
      userId: user.id,
    });
    assert.equal(atomicRestore.source.body, "source body v1");
    assert.equal(atomicRestore.source.modelAccess, "internalOnly");
    const restoredDependent = await prisma.page.findUniqueOrThrow({ where: { id: restoreDependent.page.id } });
    assert.equal(restoredDependent.body, "page synthesized from source v2");
    const restoredDependentRevision = await prisma.pageRevision.findUniqueOrThrow({
      where: { pageId_version: { pageId: restoredDependent.id, version: restoredDependent.currentVersion } },
      include: { sources: true },
    });
    assert.deepEqual(
      restoredDependentRevision.sources.map((source) => source.sourceRevisionId),
      [restoreSourceV2.revision.id],
      "policy/lifecycle restore must not rewrite unchanged Page content provenance to historical Source content",
    );

    const lifecycleSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "restore-lifecycle-cause-source",
      title: "Restore Lifecycle Cause Source",
      body: "lifecycle source body",
      context: { actor: "human", userId: user.id },
    });
    const buildArchivedNote = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "restore-lifecycle-cause-note",
      title: "Restore Lifecycle Cause Note",
      kind: "note",
      body: "note intentionally absent from restored build",
      sourceId: lifecycleSource.source.id,
      sourceRevisionIds: [lifecycleSource.revision.id],
      context: { actor: "agent" },
    });
    const archivedByBuild = await content.archivePageSnapshot({
      wikiId: wiki.id,
      pageId: buildArchivedNote.page.id,
      expectedVersion: buildArchivedNote.page.currentVersion,
      suppression: false,
      context: { actor: "system", reason: "absent from restored build fixture" },
    });
    const archivedLifecycleSource = await policy.archiveSourceWithPropagation({
      wikiId: wiki.id,
      sourceId: lifecycleSource.source.id,
      expectedVersion: lifecycleSource.source.currentVersion,
      userId: user.id,
    });
    await policy.restoreSourceRevisionWithPropagation({
      wikiId: wiki.id,
      sourceId: lifecycleSource.source.id,
      expectedVersion: archivedLifecycleSource.source.currentVersion,
      revisionId: lifecycleSource.revision.id,
      userId: user.id,
    });
    const stillBuildArchived = await prisma.page.findUniqueOrThrow({ where: { id: buildArchivedNote.page.id } });
    assert.deepEqual(
      { archivedAt: stillBuildArchived.archivedAt, version: stillBuildArchived.currentVersion },
      { archivedAt: archivedByBuild.page.archivedAt, version: archivedByBuild.page.currentVersion },
      "Source restore must not revive a note archived because it was absent from a restored build",
    );

    const provenanceRaceSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "provenance-race-source",
      title: "Provenance Race Source",
      body: "source archived while provenance writers are waiting",
      context: { actor: "human", userId: user.id },
    });
    const provenanceRacePage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "provenance-race-page",
      title: "Provenance Race Page",
      kind: "concept",
      body: "must not gain archived provenance",
      context: { actor: "human", userId: user.id },
    });
    const provenanceRacePeer = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "provenance-race-peer",
      title: "Provenance Race Peer",
      kind: "concept",
      body: "relation peer",
      context: { actor: "human", userId: user.id },
    });
    let releaseArchive!: () => void;
    let archiveEntered!: () => void;
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const archiveStarted = new Promise<void>((resolve) => { archiveEntered = resolve; });
    const archivePromise = modelAccess.withModelPolicyWriteLock(wiki.id, async (tx) => {
      const saved = await content.archiveSourceSnapshotTx(tx, {
        wikiId: wiki.id,
        sourceId: provenanceRaceSource.source.id,
        expectedVersion: provenanceRaceSource.source.currentVersion,
        context: { actor: "human", userId: user.id, reason: "provenance race archive" },
      });
      archiveEntered();
      await archiveGate;
      return saved;
    });
    await archiveStarted;
    const attachWhileArchiving = wikiStore.addPageSource(
      wiki.id,
      provenanceRacePage.page.slug,
      provenanceRaceSource.source.id,
      user.id,
    );
    const relationsWhileArchiving = wikiStore.replaceSourceRelations(
      wiki.id,
      provenanceRaceSource.source.id,
      [{
        fromSlug: provenanceRacePage.page.slug,
        toSlug: provenanceRacePeer.page.slug,
        type: "relatedTo",
      }],
    );
    const settledBeforeArchiveCommit = await Promise.race([
      Promise.all([attachWhileArchiving, relationsWhileArchiving]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(settledBeforeArchiveCommit, false, "provenance writers must wait for policy archive lock");
    releaseArchive();
    const [archivedRaceSource, , relationCount] = await Promise.all([
      archivePromise,
      attachWhileArchiving,
      relationsWhileArchiving,
    ]);
    assert.equal(relationCount, 0, "relation writer must re-read archived Source under the policy lock");
    assert.equal(
      await prisma.pageContribution.count({
        where: { pageId: provenanceRacePage.page.id, sourceId: provenanceRaceSource.source.id },
      }),
      0,
      "provenance writer must not attach a Source archived while it waited",
    );
    assert.equal(
      await prisma.conceptRelation.count({ where: { sourceId: provenanceRaceSource.source.id } }),
      0,
    );
    assert.equal(
      (await prisma.page.findUniqueOrThrow({ where: { id: provenanceRacePage.page.id } })).currentVersion,
      1,
    );
    await assert.rejects(
      content.createPageSnapshot({
        wikiId: wiki.id,
        slug: "archived-provenance-rejected",
        title: "Archived Provenance Rejected",
        kind: "concept",
        body: "must fail",
        sourceRevisionIds: [archivedRaceSource.revision.id],
        context: { actor: "human", userId: user.id },
      }),
      (error: unknown) => error instanceof content.ContentProvenanceError,
      "active Page creation must reject archived SourceRevision provenance",
    );

    const promotionRoot = promotionPolicy.pageSourcePromotionRootSlug(
      human.page.slug,
      human.page.currentVersion,
      human.revision.id,
    );
    await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: promotionRoot,
      title: "Unrelated collision Source",
      body: "This Source only occupies the deterministic promotion slug.",
      context: { actor: "human", userId: user.id },
    });
    const [promotedFirst, promotedDuplicate] = await Promise.all([
      promotion.promotePageSnapshotToSource({
        wikiId: wiki.id,
        pageSlug: human.page.slug,
        expectedVersion: human.page.currentVersion,
        userId: user.id,
      }),
      promotion.promotePageSnapshotToSource({
        wikiId: wiki.id,
        pageSlug: human.page.slug,
        expectedVersion: human.page.currentVersion,
        userId: user.id,
      }),
    ]);
    assert.equal(promotedFirst.sourceId, promotedDuplicate.sourceId, "double submit must reuse one promoted Source");
    assert.equal(promotedFirst.sourceSlug, `${promotionRoot}-2`, "an unrelated Source slug must not be overwritten");
    const promotedSource = await prisma.source.findUniqueOrThrow({
      where: { id: promotedFirst.sourceId },
      include: { revisions: true },
    });
    assert.equal(promotedSource.title, human.page.title);
    assert.equal(promotedSource.body, human.page.body);
    assert.equal(promotedSource.modelAccess, human.page.modelAccess);
    assert.equal(promotedSource.revisions.length, 1);
    assert.equal(promotedSource.revisions[0]?.actor, "human");
    assert.equal(
      promotedSource.revisions[0]?.reason,
      promotionPolicy.pageSourcePromotionReason(human.revision.id),
    );
    assert.equal(
      await prisma.page.count({ where: { wikiId: wiki.id, sourceId: promotedSource.id, kind: "note" } }),
      1,
      "promotion must create exactly one deterministic Source note",
    );
    assert.equal(
      await prisma.knowledgeBuild.count({
        where: {
          wikiId: wiki.id,
          mode: "incremental",
          inputManifest: { path: ["sourceRevisionId"], equals: promotedFirst.sourceRevisionId },
        },
      }),
      1,
      "external double submit must queue exactly one incremental build",
    );

    const internalPromotionPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "internal-promotion-page",
      title: "Internal Promotion Page",
      kind: "entity",
      body: "JIMI_INTERNAL_PROMOTION_CANARY_4M8 local-only snapshot",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const promotedInternal = await promotion.promotePageSnapshotToSource({
      wikiId: wiki.id,
      pageSlug: internalPromotionPage.page.slug,
      expectedVersion: internalPromotionPage.page.currentVersion,
      userId: user.id,
    });
    assert.equal(promotedInternal.buildId, null);
    assert.equal(
      await prisma.knowledgeBuild.count({
        where: {
          wikiId: wiki.id,
          inputManifest: { path: ["sourceRevisionId"], equals: promotedInternal.sourceRevisionId },
        },
      }),
      0,
      "internalOnly promotion must never queue an external build",
    );
    const promotedInternalSource = await prisma.source.findUniqueOrThrow({ where: { id: promotedInternal.sourceId } });
    assert.equal(promotedInternalSource.modelAccess, "internalOnly");
    assert.equal(
      await prisma.page.count({
        where: { wikiId: wiki.id, sourceId: promotedInternal.sourceId, kind: "note", modelAccess: "internalOnly" },
      }),
      1,
    );
    const localPromotionCanary = await search.localFtsSearch(wiki.id, "JIMI_INTERNAL_PROMOTION_CANARY_4M8", 10);
    const modelPromotionCanary = await search.modelSearch({
      trust: "external",
      wikiId: wiki.id,
      queryText: "JIMI_INTERNAL_PROMOTION_CANARY_4M8",
      k: 10,
    });
    assert.ok(localPromotionCanary.some((hit) => hit.refId === promotedInternal.sourceId));
    assert.equal(modelPromotionCanary.length, 0);

    const generated = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "generated-projection",
      title: "Generated Projection",
      kind: "concept",
      body: "generated v1",
      sourceRevisionIds: [external.revision.id],
      context: { actor: "agent" },
    });
    await assert.rejects(
      promotion.promotePageSnapshotToSource({
        wikiId: wiki.id,
        pageSlug: generated.page.slug,
        expectedVersion: generated.page.currentVersion,
        userId: user.id,
      }),
      (error: unknown) => error instanceof promotion.PageSourcePromotionNotAllowedError,
    );
    const updated = await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: generated.page.id,
      expectedVersion: 1,
      changes: { body: "generated v2" },
      context: { actor: "agent" },
    });
    assert.equal(updated.page.currentVersion, 2);
    await assert.rejects(
      content.updatePageSnapshot({
        wikiId: wiki.id,
        pageId: generated.page.id,
        expectedVersion: 1,
        changes: { body: "lost update" },
        context: { actor: "agent" },
      }),
      (error: unknown) => error instanceof content.ContentVersionConflictError,
    );

    const primarySourcePage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "primary-source-snapshot",
      title: "Primary Source Snapshot",
      kind: "concept",
      sourceId: external.source.id,
      sourceRevisionIds: [external.revision.id],
      context: { actor: "agent" },
    });
    const detachedPrimary = await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: primarySourcePage.page.id,
      expectedVersion: primarySourcePage.page.currentVersion,
      changes: { sourceId: null },
      sourceRevisionIds: [],
      context: { actor: "agent" },
    });
    assert.equal(detachedPrimary.page.sourceId, null);
    const restoredPrimary = await content.restorePageRevision({
      wikiId: wiki.id,
      pageId: primarySourcePage.page.id,
      expectedVersion: detachedPrimary.page.currentVersion,
      revisionId: primarySourcePage.revision.id,
      context: { actor: "restore", userId: user.id },
    });
    assert.equal(restoredPrimary.page.sourceId, external.source.id, "full Page snapshot restore must include sourceId");
    assert.equal(restoredPrimary.revision.sourceId, external.source.id);

    const proposalTarget = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "external-proposal-target",
      title: "External Proposal Target",
      kind: "concept",
      body: "human-owned body",
      context: { actor: "human", userId: user.id },
    });
    await prisma.conceptRelation.create({
      data: {
        wikiId: wiki.id,
        fromPageId: generated.page.id,
        toPageId: proposalTarget.page.id,
        type: "relatedTo",
        sourceId: external.source.id,
        sourceRevisionId: external.revision.id,
      },
    });
    const externalProposal = await builds.stageExternalPageProposal({
      wikiId: wiki.id,
      userId: user.id,
      page: {
        id: proposalTarget.page.id,
        slug: proposalTarget.page.slug,
        currentVersion: proposalTarget.page.currentVersion,
        parentId: proposalTarget.page.parentId,
        sortOrder: proposalTarget.page.sortOrder,
        modelAccess: proposalTarget.page.modelAccess,
      },
      title: proposalTarget.page.title,
      body: "external agent proposal",
      kind: "concept",
      category: null,
      sourceRevisionIds: [external.revision.id],
      buildInput: {
        sourceId: external.source.id,
        sourceSlug: external.source.slug,
        sourceRevisionId: external.revision.id,
        version: external.source.currentVersion,
        policyVersion: external.source.policyVersion,
        contentHash: external.revision.contentHash,
      },
    });
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: proposalTarget.page.id } })).body, "human-owned body");
    const proposalDraft = await prisma.knowledgeDraft.findUniqueOrThrow({ where: { id: externalProposal.draftId } });
    await builds.acceptKnowledgeDraft(externalProposal.buildId, proposalDraft.id, user.id);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: proposalTarget.page.id } })).origin, "mixed");
    assert.equal(await prisma.conceptRelation.count({ where: { wikiId: wiki.id } }), 1, "ad-hoc proposal must preserve graph projection");
    await prisma.conceptRelation.create({
      data: {
        wikiId: wiki.id,
        fromPageId: generated.page.id,
        toPageId: human.page.id,
        type: "relatedTo",
        sourceId: external.source.id,
        sourceRevisionId: external.revision.id,
      },
    });

    const manifest = {
      inputs: [{
        sourceId: external.source.id,
        sourceSlug: external.source.slug,
        sourceRevisionId: external.revision.id,
        version: external.source.currentVersion,
        policyVersion: external.source.policyVersion,
        contentHash: external.revision.contentHash,
      }],
    };
    const build = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        createdById: user.id,
        mode: "incremental",
        status: "running",
        model: "gpt-test",
        promptVersion: `${artifacts.EXTRACTION_PROMPT_VERSION}+${artifacts.SYNTHESIS_PROMPT_VERSION}`,
        rulesHash: builds.currentRulesHash(),
        inputManifest: manifest,
        relationManifest: [{
          fromSlug: "auto-published",
          toSlug: human.page.slug,
          type: "dependsOn",
          sourceRevisionId: external.revision.id,
        }],
        startedAt: new Date(),
      },
    });
    await prisma.knowledgeDraft.create({
      data: {
        buildId: build.id,
        slug: "auto-published",
        status: "staged",
        title: "Auto Published",
        body: "staged only",
        kind: "concept",
        contentHash: builds.knowledgeDraftHash({ title: "Auto Published", body: "staged only", kind: "concept", category: null, sourceRevisionIds: [external.revision.id] }),
        validation: { ok: true },
        sources: { create: { sourceRevisionId: external.revision.id } },
      },
    });
    await prisma.knowledgeDraft.create({
      data: {
        buildId: build.id,
        pageId: human.page.id,
        slug: human.page.slug,
        baseVersion: human.page.currentVersion,
        status: "conflict",
        title: "AI Proposal",
        body: "approved body",
        kind: "concept",
        contentHash: builds.knowledgeDraftHash({ title: "AI Proposal", body: "approved body", kind: "concept", category: null, sourceRevisionIds: [external.revision.id] }),
        validation: { ok: true },
        sources: { create: { sourceRevisionId: external.revision.id } },
      },
    });
    assert.equal(await prisma.page.count({ where: { wikiId: wiki.id, slug: "auto-published" } }), 0);
    const published = await builds.publishKnowledgeBuild(build.id);
    assert.equal(published.status, "review");
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { wikiId_slug: { wikiId: wiki.id, slug: "auto-published" } } })).origin, "generated");
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: human.page.id } })).body, "human base");
    assert.equal(
      await prisma.conceptRelation.count({
        where: { wikiId: wiki.id, fromPageId: generated.page.id, toPageId: human.page.id },
      }),
      1,
      "relations touching an unresolved human conflict must remain live until review",
    );

    const conflict = await prisma.knowledgeDraft.findFirstOrThrow({ where: { buildId: build.id, slug: human.page.slug } });
    const accepted = await builds.acceptKnowledgeDraft(build.id, conflict.id, user.id);
    assert.equal(accepted.accepted, true);
    const mixed = await prisma.page.findUniqueOrThrow({ where: { id: human.page.id } });
    assert.equal(mixed.origin, "mixed");
    assert.equal(mixed.body, "approved body");
    const acceptedRelation = await prisma.conceptRelation.findFirstOrThrow({
      where: { wikiId: wiki.id, from: { slug: "auto-published" }, toPageId: human.page.id },
    });
    assert.equal(acceptedRelation.type, "dependsOn");
    assert.equal(acceptedRelation.sourceRevisionId, external.revision.id);

    const suppressedPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "suppressed-generated",
      title: "Suppressed Generated",
      kind: "concept",
      body: "do not recreate",
      sourceRevisionIds: [external.revision.id],
      context: { actor: "agent" },
    });
    const archivedSuppression = await content.archivePageSnapshot({
      wikiId: wiki.id,
      pageId: suppressedPage.page.id,
      expectedVersion: suppressedPage.page.currentVersion,
      suppression: true,
      context: { actor: "human", userId: user.id },
    });
    const suppressionBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        mode: "full",
        status: "running",
        promptVersion: `${artifacts.EXTRACTION_PROMPT_VERSION}+${artifacts.SYNTHESIS_PROMPT_VERSION}`,
        rulesHash: builds.currentRulesHash(),
        inputManifest: manifest,
        relationManifest: [],
      },
    });
    await prisma.knowledgeDraft.create({
      data: {
        buildId: suppressionBuild.id,
        pageId: suppressedPage.page.id,
        slug: suppressedPage.page.slug,
        baseVersion: archivedSuppression.page.currentVersion,
        status: "staged",
        title: "Suppressed Generated Again",
        body: "must remain archived",
        kind: "concept",
        contentHash: builds.knowledgeDraftHash({ title: "Suppressed Generated Again", body: "must remain archived", kind: "concept", category: null, sourceRevisionIds: [external.revision.id] }),
        validation: { ok: true },
        sources: { create: { sourceRevisionId: external.revision.id } },
      },
    });
    const suppressionResult = await builds.publishKnowledgeBuild(suppressionBuild.id);
    assert.equal(suppressionResult.suppressed, 1);
    assert.ok((await prisma.page.findUniqueOrThrow({ where: { id: suppressedPage.page.id } })).suppressedAt);
    const explicitlyRestored = await content.restoreArchivedPage({
      wikiId: wiki.id,
      pageId: suppressedPage.page.id,
      expectedVersion: archivedSuppression.page.currentVersion,
      context: { actor: "restore", userId: user.id },
    });
    assert.equal(explicitlyRestored.page.origin, "generated");
    assert.equal(explicitlyRestored.page.suppressedAt, null);

    const staleBase = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "stale-base",
      title: "Stale Base",
      kind: "concept",
      body: "base",
      sourceRevisionIds: [external.revision.id],
      context: { actor: "agent" },
    });
    const staleBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        mode: "incremental",
        status: "running",
        promptVersion: `${artifacts.EXTRACTION_PROMPT_VERSION}+${artifacts.SYNTHESIS_PROMPT_VERSION}`,
        rulesHash: builds.currentRulesHash(),
        inputManifest: manifest,
        relationManifest: [],
      },
    });
    await prisma.knowledgeDraft.create({
      data: {
        buildId: staleBuild.id,
        pageId: staleBase.page.id,
        slug: staleBase.page.slug,
        baseVersion: staleBase.page.currentVersion,
        status: "staged",
        title: staleBase.page.title,
        body: "draft update",
        kind: "concept",
        contentHash: builds.knowledgeDraftHash({ title: staleBase.page.title, body: "draft update", kind: "concept", category: null, sourceRevisionIds: [external.revision.id] }),
        validation: { ok: true },
        sources: { create: { sourceRevisionId: external.revision.id } },
      },
    });
    await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: staleBase.page.id,
      expectedVersion: staleBase.page.currentVersion,
      changes: { body: "concurrent update" },
      context: { actor: "agent" },
    });
    const staleResult = await builds.publishKnowledgeBuild(staleBuild.id);
    assert.equal(staleResult.stale, 1);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: staleBase.page.id } })).body, "concurrent update");

    const targetBuild = await prisma.knowledgeBuild.findUniqueOrThrow({ where: { id: build.id } });
    assert.equal(targetBuild.status, "published");
    const archivedRelationFrom = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "checkpoint-archived-relation-from",
      title: "Checkpoint Archived Relation From",
      kind: "concept",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    const archivedRelationTo = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "checkpoint-archived-relation-to",
      title: "Checkpoint Archived Relation To",
      kind: "concept",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    await prisma.conceptRelation.create({
      data: {
        wikiId: wiki.id,
        fromPageId: archivedRelationFrom.page.id,
        toPageId: archivedRelationTo.page.id,
        type: "relatedTo",
        sourceId: external.source.id,
        sourceRevisionId: external.revision.id,
      },
    });
    await content.archivePageSnapshot({
      wikiId: wiki.id,
      pageId: archivedRelationFrom.page.id,
      expectedVersion: archivedRelationFrom.page.currentVersion,
      suppression: true,
      context: { actor: "human", userId: user.id },
    });
    const changedHuman = await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: mixed.id,
      expectedVersion: mixed.currentVersion,
      changes: { body: "later body", modelAccess: "internalOnly" },
      context: { actor: "human", userId: user.id },
    });
    const restored = await builds.restoreKnowledgeBuild(build.id, user.id);
    assert.equal(restored.status, "published");
    const checkpoint = await prisma.knowledgeBuild.findUniqueOrThrow({ where: { id: restored.checkpointBuildId } });
    const checkpointManifest = builds.parsePublishedBuildManifest(checkpoint.publishedManifest);
    assert.equal(
      checkpointManifest.relations.some((relation) => relation.fromSlug === archivedRelationFrom.page.slug),
      false,
      "checkpoint must not retain relations whose endpoint is absent from its active Page manifest",
    );
    assert.equal(checkpoint.restorable, true);
    const restoredHuman = await prisma.page.findUniqueOrThrow({ where: { id: human.page.id } });
    assert.equal(restoredHuman.body, "approved body");
    assert.equal(restoredHuman.modelAccess, "internalOnly", "restore must not relax current policy");
    assert.ok(restoredHuman.currentVersion > changedHuman.page.currentVersion);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: generated.page.id } })).origin, "generated");

    const downgradePage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "downgrade-projection",
      title: "Downgrade Projection",
      kind: "concept",
      body: "source-backed external page",
      sourceRevisionIds: [external.revision.id],
      context: { actor: "agent" },
    });
    await projections.refreshPageDerivedState(wiki.id, downgradePage.page.id);
    const seededVectors = await prisma.$executeRawUnsafe(
      `UPDATE "SearchChunk"
       SET embedding = array_fill(0.01::real, ARRAY[768])::vector
       WHERE "wikiId"=$1 AND "modelAccess"='external'
         AND (("refType"='page' AND "refId"=$2) OR ("refType"='source' AND "refId"=$3))`,
      wiki.id,
      downgradePage.page.id,
      external.source.id,
    );
    assert.ok(seededVectors >= 2, "downgrade test must exercise non-null vectors");
    const pendingRun = await prisma.agentRun.create({ data: { wikiId: wiki.id, type: "rebuild", status: "pending" } });
    await prisma.knowledgeBuild.create({
      data: { wikiId: wiki.id, agentRunId: pendingRun.id, mode: "full", status: "pending" },
    });
    const runningPolicyBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        mode: "incremental",
        status: "running",
        promptVersion: `${artifacts.EXTRACTION_PROMPT_VERSION}+${artifacts.SYNTHESIS_PROMPT_VERSION}`,
        rulesHash: builds.currentRulesHash(),
        inputManifest: manifest,
        relationManifest: [],
      },
    });
    await prisma.knowledgeDraft.create({
      data: {
        buildId: runningPolicyBuild.id,
        slug: "must-not-publish-after-downgrade",
        status: "staged",
        title: "Must Not Publish",
        body: "policy changed",
        kind: "concept",
        contentHash: builds.knowledgeDraftHash({ title: "Must Not Publish", body: "policy changed", kind: "concept", category: null, sourceRevisionIds: [external.revision.id] }),
        validation: { ok: true },
        sources: { create: { sourceRevisionId: external.revision.id } },
      },
    });
    const downgraded = await policy.changeSourceModelAccess({
      wikiId: wiki.id,
      sourceId: external.source.id,
      expectedVersion: external.source.currentVersion,
      modelAccess: "internalOnly",
      userId: user.id,
    });
    assert.ok(downgraded.pageRevisions.length >= 1);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: downgradePage.page.id } })).modelAccess, "internalOnly");
    assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: pendingRun.id } })).status, "error");
    const leakedVectors = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "SearchChunk"
       WHERE "wikiId"=$1 AND "modelAccess"='internalOnly' AND embedding IS NOT NULL`,
      wiki.id,
    );
    assert.equal(leakedVectors[0]?.n, 0, "policy downgrade must atomically clear existing vectors");
    await assert.rejects(builds.publishKnowledgeBuild(runningPolicyBuild.id), /policy\/version changed/);
    assert.equal(await prisma.page.count({ where: { wikiId: wiki.id, slug: "must-not-publish-after-downgrade" } }), 0);

    const parentForPurge = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-parent",
      title: "Purge Parent",
      kind: "concept",
      context: { actor: "human", userId: user.id },
    });
    const childForPurge = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-child",
      title: "Purge Child",
      kind: "concept",
      parentId: parentForPurge.page.id,
      context: { actor: "human", userId: user.id },
    });
    await content.purgePage({
      wikiId: wiki.id,
      pageId: parentForPurge.page.id,
      expectedVersion: parentForPurge.page.currentVersion,
    });
    const detachedChild = await prisma.page.findUniqueOrThrow({ where: { id: childForPurge.page.id } });
    assert.equal(detachedChild.parentId, null);
    assert.equal(detachedChild.currentVersion, 2, "purge FK detach must be revisioned");
    assert.equal(
      (await prisma.pageRevision.findUniqueOrThrow({
        where: { pageId_version: { pageId: detachedChild.id, version: detachedChild.currentVersion } },
      })).parentId,
      null,
    );

    const purgeStorageKey = blob.makeStorageKey(wiki.id, "txt");
    await blob.getBlobStore().put(purgeStorageKey, Buffer.from("PURGE_SOURCE_BLOB_CANARY"));
    const purgeSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "purge-source-with-dependents",
      title: "Purge Source With Dependents",
      body: "PURGE_SOURCE_CANARY",
      storageKey: purgeStorageKey,
      context: { actor: "human", userId: user.id },
    });
    const purgeNote = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-source-note",
      title: "Purge Source Note",
      kind: "note",
      body: "PURGE_SOURCE_CANARY",
      sourceId: purgeSource.source.id,
      sourceRevisionIds: [purgeSource.revision.id],
      context: { actor: "agent" },
    });
    const purgeDerived = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-source-derived",
      title: "Purge Source Derived",
      kind: "concept",
      body: "derived",
      sourceId: purgeSource.source.id,
      sourceRevisionIds: [purgeSource.revision.id],
      context: { actor: "agent" },
    });
    const relationOnlyFrom = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-relation-only-from",
      title: "Purge Relation Only From",
      kind: "concept",
      context: { actor: "human", userId: user.id },
    });
    const relationOnlyTo = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-relation-only-to",
      title: "Purge Relation Only To",
      kind: "concept",
      context: { actor: "human", userId: user.id },
    });
    const relationOnlyBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        mode: "restore",
        status: "published",
        publishedAt: new Date(),
        inputManifest: {},
        relationManifest: [],
        publishedManifest: {
          pages: [relationOnlyFrom, relationOnlyTo].map(({ page, revision }) => ({
            pageId: page.id,
            slug: page.slug,
            pageRevisionId: revision.id,
            version: revision.version,
            contentHash: revision.contentHash,
          })),
          relations: [{
            fromSlug: relationOnlyFrom.page.slug,
            toSlug: relationOnlyTo.page.slug,
            type: "relatedTo",
            sourceId: purgeSource.source.id,
            sourceRevisionId: purgeSource.revision.id,
          }],
        },
        pageManifest: {
          create: [relationOnlyFrom, relationOnlyTo].map(({ page, revision }) => ({
            pageId: page.id,
            pageRevisionId: revision.id,
            slug: page.slug,
          })),
        },
      },
    });
    await Promise.all([
      projections.refreshSourceDerivedState(wiki.id, purgeSource.source.id),
      projections.refreshPageDerivedState(wiki.id, purgeNote.page.id),
      projections.refreshPageDerivedState(wiki.id, purgeDerived.page.id),
    ]);
    const purgedSource = await content.purgeSource({
      wikiId: wiki.id,
      sourceId: purgeSource.source.id,
      expectedVersion: purgeSource.source.currentVersion,
    });
    assert.equal(purgedSource.storageKeys.includes(purgeStorageKey), true);
    assert.ok(purgedSource.cleanupLogId, "purge must commit a durable exact-key cleanup job before deleting Source");
    assert.equal(await blob.getBlobStore().exists(purgeStorageKey), true);
    const blobCleanup = await blobPurge.processBlobPurgeLog(purgedSource.cleanupLogId!);
    assert.deepEqual(blobCleanup, { completed: true, remaining: 0 });
    assert.equal(await blob.getBlobStore().exists(purgeStorageKey), false);
    assert.equal(
      (await prisma.logEntry.findUniqueOrThrow({ where: { id: purgedSource.cleanupLogId! } })).title,
      blobPurge.BLOB_PURGE_COMPLETE_TITLE,
    );
    assert.equal(await prisma.page.count({ where: { id: purgeNote.page.id } }), 0, "dedicated note must be purged with Source");
    const detachedDerived = await prisma.page.findUniqueOrThrow({ where: { id: purgeDerived.page.id } });
    assert.equal(detachedDerived.sourceId, null);
    assert.equal(detachedDerived.currentVersion, 2);
    const detachedDerivedRevision = await prisma.pageRevision.findUniqueOrThrow({
      where: { pageId_version: { pageId: detachedDerived.id, version: detachedDerived.currentVersion } },
      include: { sources: true },
    });
    assert.equal(detachedDerivedRevision.sourceId, null);
    assert.equal(detachedDerivedRevision.sources.length, 0);
    assert.equal(
      await prisma.searchChunk.count({
        where: { wikiId: wiki.id, OR: [{ refId: purgeSource.source.id }, { refId: purgeNote.page.id }] },
      }),
      0,
    );
    assert.equal(
      (await prisma.knowledgeBuild.findUniqueOrThrow({ where: { id: relationOnlyBuild.id } })).restorable,
      false,
      "purge must invalidate builds that reference the exact SourceRevision only in publishedManifest.relations",
    );

    const purgeTarget = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "purge-target",
      title: "Purge Target",
      kind: "concept",
      body: "permanent",
      context: { actor: "human", userId: user.id },
    });
    const manifestBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        mode: "restore",
        status: "published",
        publishedAt: new Date(),
        publishedManifest: {
          pages: [{
            pageId: purgeTarget.page.id,
            slug: purgeTarget.page.slug,
            pageRevisionId: purgeTarget.revision.id,
            version: purgeTarget.revision.version,
            contentHash: purgeTarget.revision.contentHash,
          }],
          relations: [],
        },
        pageManifest: {
          create: {
            pageId: purgeTarget.page.id,
            pageRevisionId: purgeTarget.revision.id,
            slug: purgeTarget.page.slug,
          },
        },
      },
    });
    await content.purgePage({ wikiId: wiki.id, pageId: purgeTarget.page.id, expectedVersion: 1 });
    assert.equal((await prisma.knowledgeBuild.findUniqueOrThrow({ where: { id: manifestBuild.id } })).restorable, false);
  } finally {
    await prisma.$disconnect();
  }
});
