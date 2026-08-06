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

test("documents, agent capture placement/idempotency, preserve/search scopes, promotion idempotency, and API-key isolation", async () => {
  assertIsolatedLocalDatabase();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const [db, content, documents, builds, ingest, search, wikiStore, lint, projections, keys, apiGate, pagesRoute, pageRoute, documentsRoute, runRoute, ingestRoute, searchRoute, promotion] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/content-store"),
    import("../../src/lib/documents"),
    import("../../src/lib/builds"),
    import("../../src/lib/ingest"),
    import("../../src/lib/search"),
    import("../../src/lib/wiki"),
    import("../../src/lib/lint"),
    import("../../src/lib/page-projections"),
    import("../../src/lib/apikey"),
    import("../../src/lib/api-gate"),
    import("../../src/app/api/wikis/[id]/pages/route"),
    import("../../src/app/api/wikis/[id]/pages/[pageSlug]/route"),
    import("../../src/app/api/wikis/[id]/documents/route"),
    import("../../src/app/api/wikis/[id]/runs/[runId]/route"),
    import("../../src/app/api/wikis/[id]/ingest/route"),
    import("../../src/app/api/wikis/[id]/search/route"),
    import("../../src/lib/saved-link-promotion"),
  ]);
  const { prisma } = db;
  let deferredBlobKey: string | null = null;

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const user = await prisma.user.create({
      data: { email: "documents-integration@example.invalid", emailVerified: new Date() },
    });
    const wiki = await prisma.wiki.create({
      data: {
        slug: "documents-integration",
        title: "Documents Integration",
        kind: "project",
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });
    const otherWiki = await prisma.wiki.create({
      data: {
        slug: "other-integration",
        title: "Other Integration",
        kind: "personal",
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });

    const documentAtV1 = new Date("2026-07-20T01:00:00.000Z");
    const created = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "human",
      externalAgent: false,
      title: "Human Worklog",
      body: "base body [[graph-concept]]",
      documentType: "worklog",
      documentAt: documentAtV1,
    });
    assert.equal(created.staged, false);
    if (created.staged) throw new Error("unreachable");
    assert.equal(created.page.sourceId, null);
    const documentAtV2 = new Date("2026-07-21T02:00:00.000Z");
    const updated = await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: created.page.id,
      expectedVersion: created.page.currentVersion,
      changes: { body: "human v2", documentType: "decision", documentAt: documentAtV2 },
      sourceRevisionIds: [],
      context: { actor: "human", userId: user.id },
    });
    assert.equal(updated.revision.documentType, "decision");
    assert.equal(updated.revision.documentAt?.toISOString(), documentAtV2.toISOString());
    const restored = await content.restorePageRevision({
      wikiId: wiki.id,
      pageId: created.page.id,
      expectedVersion: updated.page.currentVersion,
      revisionId: created.page.currentVersion === 1 ? (await prisma.pageRevision.findUniqueOrThrow({
        where: { pageId_version: { pageId: created.page.id, version: 1 } },
      })).id : "",
      context: { actor: "restore", userId: user.id },
    });
    assert.equal(restored.page.documentType, "worklog");
    assert.equal(restored.page.documentAt?.toISOString(), documentAtV1.toISOString());
    assert.equal(restored.revision.documentType, "worklog");

    const stagedAttempts = await Promise.allSettled([
      documents.appendDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        slug: restored.page.slug,
        content: "agent append A",
        expectedVersion: restored.page.currentVersion,
      }),
      documents.appendDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        slug: restored.page.slug,
        content: "agent append B",
        expectedVersion: restored.page.currentVersion,
      }),
    ]);
    assert.equal(stagedAttempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(stagedAttempts.filter((result) => result.status === "rejected").length, 1);
    const staged = stagedAttempts.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof documents.appendDocument>>> => result.status === "fulfilled")!.value;
    assert.equal(staged.staged, true);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: created.page.id } })).body, "base body [[graph-concept]]");
    if (!staged.staged) throw new Error("expected staged append");
    const draft = await prisma.knowledgeDraft.findUniqueOrThrow({ where: { id: staged.draftId } });
    assert.equal(draft.documentType, "worklog");
    assert.equal(draft.documentAt?.toISOString(), documentAtV1.toISOString());
    await builds.acceptKnowledgeDraft(staged.buildId, staged.draftId, user.id);
    const accepted = await prisma.page.findUniqueOrThrow({ where: { id: created.page.id } });
    assert.match(accepted.body, /agent append [AB]$/);
    assert.equal(accepted.documentType, "worklog");
    assert.equal(accepted.documentAt?.toISOString(), documentAtV1.toISOString());

    const generated = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "agent",
      externalAgent: true,
      title: "Generated Plan",
      body: "generated base",
      documentType: "plan",
      documentAt: documentAtV2,
    });
    assert.equal(generated.staged, false);
    if (generated.staged) throw new Error("unreachable");
    const directAttempts = await Promise.allSettled([
      documents.appendDocument({ wikiId: wiki.id, userId: user.id, actor: "agent", externalAgent: true, slug: generated.page.slug, content: "one", expectedVersion: 1 }),
      documents.appendDocument({ wikiId: wiki.id, userId: user.id, actor: "agent", externalAgent: true, slug: generated.page.slug, content: "two", expectedVersion: 1 }),
    ]);
    assert.equal(directAttempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(directAttempts.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: generated.page.id } })).currentVersion, 2);

    const concept = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "graph-concept",
      title: "Graph Concept",
      kind: "concept",
      body: "concept body",
      context: { actor: "human", userId: user.id },
    });
    await Promise.all([
      projections.refreshPageDerivedState(wiki.id, accepted.id),
      projections.refreshPageDerivedState(wiki.id, concept.page.id),
    ]);
    const graph = await wikiStore.getWikiGraph(wiki.id);
    assert.equal(graph.nodes.some((node) => node.slug === accepted.slug), true, "document wikilinks remain in the general PageLink graph");
    const report = await lint.lintWiki(wiki.id, { persist: false });
    assert.equal(report.orphanPages.some((page) => page.slug === accepted.slug), false);
    assert.equal(report.noOutLinks.some((page) => page.slug === accepted.slug), false);

    const curatedSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "curated-source",
      title: "Curated Source",
      body: "CURATED_SCOPE_CANARY",
      context: { actor: "human", userId: user.id },
    });
    assert.equal(curatedSource.source.curationState, "curated");
    assert.equal(await wikiStore.replaceSourceRelations(wiki.id, curatedSource.source.id, [{
      fromSlug: accepted.slug,
      toSlug: concept.page.slug,
      type: "relatedTo",
    }]), 0, "document endpoints must never enter ConceptRelation");

    const usageBefore = await prisma.usageEvent.count({ where: { wikiId: wiki.id } });
    const buildsBefore = await prisma.knowledgeBuild.count({ where: { wikiId: wiki.id } });
    const preserved = await ingest.ingestSource(wiki.id, {
      text: "PRESERVED_SCOPE_CANARY exact pasted text",
      title: "Preserved Source",
      mode: "preserve",
    }, user.id);
    assert.equal(preserved.outcome, "preserved");
    assert.equal(preserved.textExtracted, true);
    assert.equal(await prisma.knowledgeBuild.count({ where: { wikiId: wiki.id } }), buildsBefore);
    assert.equal(await prisma.usageEvent.count({ where: { wikiId: wiki.id } }), usageBefore);
    const preservedSource = await prisma.source.findUniqueOrThrow({
      where: { wikiId_slug: { wikiId: wiki.id, slug: preserved.sourceSlug } },
    });
    assert.equal(preservedSource.curationState, "preserved");
    assert.equal(preservedSource.body, "PRESERVED_SCOPE_CANARY exact pasted text");
    const pointer = await prisma.page.findFirstOrThrow({ where: { wikiId: wiki.id, sourceId: preservedSource.id, kind: "note" } });
    assert.doesNotMatch(pointer.body, /PRESERVED_SCOPE_CANARY/);
    assert.match(pointer.body, /원문만 보존됨/);
    const tocAfterPreserve = await wikiStore.getWikiToc(wiki.id);
    assert.equal(
      tocAfterPreserve.flat.some((entry) => entry.slug === pointer.slug),
      false,
      "source projection notes stay out of the user-facing TOC",
    );
    assert.equal(tocAfterPreserve.sections.some((section) => section.key === "sources"), false);

    const preservedSecond = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "research-source-b",
      title: "Research Source B",
      url: "https://example.com/research-b",
      body: "RESEARCH_SOURCE_B_CANARY",
      curationState: "preserved",
      context: { actor: "human", userId: user.id },
    });
    const otherWikiSource = await content.createSourceSnapshot({
      wikiId: otherWiki.id,
      slug: "other-wiki-research-source",
      title: "Other Wiki Research Source",
      body: "must not cross tenant boundary",
      curationState: "preserved",
      context: { actor: "human", userId: user.id },
    });
    const researchBody = [
      "## 요약",
      "",
      `B 주장 [@${preservedSecond.source.slug}], A 주장 [@${preservedSource.slug}].`,
      "",
      `재인용 [@${preservedSecond.source.slug}].`,
      "",
      "```text",
      "[@code-only-citation]",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n");
    const research = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "agent",
      externalAgent: true,
      title: "Generated Research Report",
      body: researchBody,
      documentType: "research",
      sourceSlugs: [preservedSecond.source.slug, preservedSource.slug],
    });
    assert.equal(research.staged, false);
    if (research.staged) throw new Error("unreachable");
    assert.equal(research.page.category, "research");
    assert.equal(research.page.currentVersion, 1);
    const researchV1 = await prisma.pageRevision.findUniqueOrThrow({
      where: { pageId_version: { pageId: research.page.id, version: 1 } },
      include: { sources: { orderBy: { ordinal: "asc" } } },
    });
    assert.deepEqual(researchV1.sources.map((source) => source.sourceSlug), [
      preservedSecond.source.slug,
      preservedSource.slug,
    ]);
    assert.deepEqual(researchV1.sources.map((source) => source.ordinal), [0, 1]);
    assert.equal(new Set(researchV1.sources.map((source) => source.sourceRevisionId)).size, 2);
    const usedByPreserved = await wikiStore.getSourceUsedPages(wiki.id, preservedSource.id);
    assert.equal(usedByPreserved.some((page) => page.slug === research.page.slug && page.kind === "document"), true);
    assert.equal(usedByPreserved.some((page) => page.slug === pointer.slug), false);
    const researchNeighbors = await wikiStore.getPrevNext(wiki.id, research.page.slug);
    for (const neighbor of [researchNeighbors.prev, researchNeighbors.next]) {
      if (!neighbor) continue;
      const neighborPage = await prisma.page.findUniqueOrThrow({
        where: { wikiId_slug: { wikiId: wiki.id, slug: neighbor.slug } },
        select: { kind: true },
      });
      assert.equal(neighborPage.kind, "document", "document navigation must stay inside the document section");
    }
    const sourceNeighbors = await wikiStore.getSourcePrevNext(wiki.id, preservedSource.id);
    for (const neighbor of [sourceNeighbors.prev, sourceNeighbors.next]) {
      if (!neighbor) continue;
      assert.notEqual(neighbor.slug, preservedSource.slug);
      assert.notEqual(neighbor.slug, otherWikiSource.source.slug);
    }

    const filterTerm = "RESEARCH_FILTER_SATURATION_CANARY";
    const generalSearchPages = Array.from({ length: search.POOL + 5 }, (_, index) => ({
      id: `search-general-${index}`,
      wikiId: wiki.id,
      slug: `search-general-${index}`,
      title: `Search General ${index}`,
      kind: "document" as const,
      documentType: "general" as const,
      documentAt: new Date("2026-07-20T00:00:00.000Z"),
      origin: "generated" as const,
      modelAccess: "external" as const,
    }));
    await prisma.page.createMany({ data: generalSearchPages });
    await prisma.searchChunk.createMany({
      data: [
        ...generalSearchPages.map((page, index) => ({
          id: `search-general-chunk-${index}`,
          wikiId: wiki.id,
          refType: "page",
          refId: page.id,
          heading: "",
          text: Array.from({ length: 20 }, () => filterTerm).join(" "),
          hash: `search-general-hash-${index}`,
          modelAccess: "external" as const,
        })),
        {
          id: "search-research-chunk",
          wikiId: wiki.id,
          refType: "page",
          refId: research.page.id,
          heading: "",
          text: filterTerm,
          hash: "search-research-hash",
          modelAccess: "external" as const,
        },
      ],
    });
    const filteredResearch = await search.modelSearch({
      trust: "external",
      wikiId: wiki.id,
      queryText: filterTerm,
      k: 10,
      scope: "documents",
      documentType: "research",
    });
    assert.deepEqual(
      filteredResearch.map((hit) => hit.refId),
      [research.page.id],
      "documentType filter must apply before the candidate pool limit",
    );
    await prisma.searchChunk.deleteMany({
      where: {
        id: {
          in: [
            "search-research-chunk",
            ...generalSearchPages.map((_, index) => `search-general-chunk-${index}`),
          ],
        },
      },
    });
    await prisma.page.deleteMany({
      where: { id: { in: generalSearchPages.map((page) => page.id) } },
    });

    await assert.rejects(
      documents.writeDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        title: "Mismatched Research",
        body: `근거 [@${preservedSource.slug}]`,
        documentType: "research",
        sourceSlugs: [preservedSecond.source.slug],
      }),
      /research_citations_source_slugs_mismatch/,
    );
    await assert.rejects(
      documents.writeDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        title: "Cross Wiki Research",
        body: `근거 [@${otherWikiSource.source.slug}]`,
        documentType: "research",
        sourceSlugs: [otherWikiSource.source.slug],
      }),
      /research_source_not_found/,
    );
    await assert.rejects(
      documents.writeDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        title: "Curated Source Research",
        body: `근거 [@${curatedSource.source.slug}]`,
        documentType: "research",
        sourceSlugs: [curatedSource.source.slug],
      }),
      /research_source_not_found/,
    );
    await assert.rejects(
      documents.writeDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        title: "General With Source",
        body: "no provenance",
        documentType: "general",
        sourceSlugs: [preservedSource.slug],
      }),
      /document_source_provenance_forbidden/,
    );

    const updatedResearch = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "agent",
      externalAgent: true,
      slug: research.page.slug,
      title: research.page.title,
      body: `${researchBody}\n\n## 결론\n\n두 근거를 함께 본다.`,
      documentType: "research",
      sourceSlugs: [preservedSecond.source.slug, preservedSource.slug],
      expectedVersion: research.page.currentVersion,
    });
    assert.equal(updatedResearch.staged, false);
    if (updatedResearch.staged) throw new Error("unreachable");
    assert.equal(updatedResearch.page.currentVersion, 2);
    await assert.rejects(
      documents.writeDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        slug: research.page.slug,
        title: research.page.title,
        body: researchBody,
        documentType: "research",
        sourceSlugs: [preservedSecond.source.slug, preservedSource.slug],
        expectedVersion: 1,
      }),
      /version conflict/,
    );
    await assert.rejects(
      documents.appendDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        slug: research.page.slug,
        content: "append is unsafe",
        expectedVersion: 2,
      }),
      /research_append_forbidden/,
    );

    const humanResearch = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "human",
      externalAgent: false,
      title: "Human Research Report",
      body: `사람 보고서 [@${preservedSource.slug}]`,
      documentType: "research",
      sourceSlugs: [preservedSource.slug],
    });
    assert.equal(humanResearch.staged, false);
    if (humanResearch.staged) throw new Error("unreachable");
    const stagedResearch = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "agent",
      externalAgent: true,
      slug: humanResearch.page.slug,
      title: humanResearch.page.title,
      body: `에이전트 제안 [@${preservedSource.slug}]`,
      documentType: "research",
      sourceSlugs: [preservedSource.slug],
      expectedVersion: humanResearch.page.currentVersion,
    });
    assert.equal(stagedResearch.staged, true);
    if (!stagedResearch.staged) throw new Error("expected staged research");
    const stagedResearchSources = await prisma.knowledgeDraftSource.findMany({
      where: { draftId: stagedResearch.draftId },
      orderBy: { ordinal: "asc" },
    });
    assert.deepEqual(stagedResearchSources.map((source) => source.ordinal), [0]);
    await builds.acceptKnowledgeDraft(stagedResearch.buildId, stagedResearch.draftId, user.id);
    const acceptedResearch = await prisma.page.findUniqueOrThrow({ where: { id: humanResearch.page.id } });
    assert.equal(acceptedResearch.origin, "mixed");
    assert.equal(acceptedResearch.currentVersion, 2);

    const archivedEvidenceSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "research-source-archive",
      title: "Research Source Archive",
      body: "RESEARCH_SOURCE_ARCHIVE_CANARY",
      curationState: "preserved",
      context: { actor: "human", userId: user.id },
    });
    const archiveResearch = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "agent",
      externalAgent: true,
      title: "Archive Lifecycle Research",
      body: `근거 [@${archivedEvidenceSource.source.slug}]`,
      documentType: "research",
      sourceSlugs: [archivedEvidenceSource.source.slug],
    });
    assert.equal(archiveResearch.staged, false);
    if (archiveResearch.staged) throw new Error("unreachable");
    const { trashSource } = await import("../../src/lib/trash");
    await trashSource({
      wikiId: wiki.id,
      sourceId: archivedEvidenceSource.source.id,
      expectedVersion: archivedEvidenceSource.source.currentVersion,
      userId: user.id,
    });
    const archiveResearchAfter = await prisma.page.findUniqueOrThrow({ where: { id: archiveResearch.page.id } });
    assert.ok(archiveResearchAfter.staleAt);
    assert.equal(archiveResearchAfter.currentVersion, 2);
    const archiveResearchEvidence = await prisma.pageRevisionSource.findMany({
      where: {
        pageRevision: {
          pageId: archiveResearch.page.id,
          version: archiveResearchAfter.currentVersion,
        },
      },
    });
    assert.deepEqual(archiveResearchEvidence.map((source) => source.sourceRevisionId), [
      archivedEvidenceSource.revision.id,
    ], "archive lifecycle must preserve the exact cited SourceRevision rather than retargeting it");

    const researchBeforePurge = await prisma.page.findUniqueOrThrow({ where: { id: research.page.id } });
    await content.purgeSource({
      wikiId: wiki.id,
      sourceId: preservedSecond.source.id,
      expectedVersion: preservedSecond.source.currentVersion,
    });
    const researchAfterPurge = await prisma.page.findUniqueOrThrow({ where: { id: research.page.id } });
    assert.equal(researchAfterPurge.currentVersion, researchBeforePurge.currentVersion + 1);
    assert.ok(researchAfterPurge.staleAt);
    const purgedEvidence = await prisma.pageRevision.findUniqueOrThrow({
      where: {
        pageId_version: {
          pageId: research.page.id,
          version: researchAfterPurge.currentVersion,
        },
      },
      include: { sources: { orderBy: { ordinal: "asc" } } },
    });
    assert.equal(purgedEvidence.sources[0]?.sourceRevisionId, null);
    assert.equal(purgedEvidence.sources[0]?.sourceSlug, preservedSecond.source.slug);
    assert.ok(purgedEvidence.sources[0]?.purgedAt);
    assert.equal(purgedEvidence.sources[1]?.sourceSlug, preservedSource.slug);
    const restoredResearch = await content.restorePageRevision({
      wikiId: wiki.id,
      pageId: research.page.id,
      expectedVersion: researchAfterPurge.currentVersion,
      revisionId: researchV1.id,
      context: { actor: "restore", userId: user.id },
    });
    assert.ok(restoredResearch.page.staleAt);
    const restoredResearchEvidence = await prisma.pageRevisionSource.findMany({
      where: { pageRevisionId: restoredResearch.revision.id },
      orderBy: { ordinal: "asc" },
    });
    assert.equal(restoredResearchEvidence[0]?.sourceRevisionId, null);
    assert.equal(restoredResearchEvidence[0]?.sourceSlug, preservedSecond.source.slug);

    const isolationBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        createdById: user.id,
        mode: "full",
        status: "running",
        inputManifest: { inputs: [] },
        startedAt: new Date(),
      },
    });
    await builds.stageBuildDrafts(isolationBuild.id, new Map());
    assert.equal(await prisma.knowledgeDraft.count({
      where: { buildId: isolationBuild.id, pageId: { in: [pointer.id, generated.page.id] } },
    }), 0, "preserved pointer notes and documents are outside KnowledgeBuild stale management");

    await search.reindexSource(wiki.id, { id: curatedSource.source.id, slug: curatedSource.source.slug, body: curatedSource.source.body ?? "" });
    const preservedKnowledge = await search.modelSearch({ trust: "external", wikiId: wiki.id, queryText: "PRESERVED_SCOPE_CANARY", k: 10, scope: "knowledge" });
    const preservedDocuments = await search.modelSearch({ trust: "external", wikiId: wiki.id, queryText: "PRESERVED_SCOPE_CANARY", k: 10, scope: "documents" });
    assert.equal(preservedKnowledge.some((hit) => hit.refId === preservedSource.id), false);
    assert.equal(preservedDocuments.some((hit) => hit.refId === preservedSource.id), true);
    const curatedKnowledge = await search.modelSearch({ trust: "external", wikiId: wiki.id, queryText: "CURATED_SCOPE_CANARY", k: 10, scope: "knowledge" });
    const curatedDocuments = await search.modelSearch({ trust: "external", wikiId: wiki.id, queryText: "CURATED_SCOPE_CANARY", k: 10, scope: "documents" });
    assert.equal(curatedKnowledge.some((hit) => hit.refId === curatedSource.source.id), true);
    assert.equal(curatedDocuments.some((hit) => hit.refId === curatedSource.source.id), false);

    // Target Source의 초안은 사람 페이지와 충돌하고, 무관한 curated Source 초안만 게시되는 경우
    // 무관한 성공을 근거로 target Source를 curated로 승격하면 안 된다.
    const conflictTarget = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "conflict-curation-target",
      title: "Conflict Curation Target",
      body: "target source body",
      curationState: "preserved",
      context: { actor: "human", userId: user.id },
    });
    const conflictTargetPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "conflict-curation-page",
      title: "Human Conflict Page",
      body: "human-owned body",
      kind: "concept",
      context: { actor: "human", userId: user.id },
    });
    const [targetRevision, unrelatedRevision] = await Promise.all([
      prisma.sourceRevision.findUniqueOrThrow({
        where: { sourceId_version: { sourceId: conflictTarget.source.id, version: conflictTarget.source.currentVersion } },
      }),
      prisma.sourceRevision.findUniqueOrThrow({
        where: { sourceId_version: { sourceId: curatedSource.source.id, version: curatedSource.source.currentVersion } },
      }),
    ]);
    const conflictRun = await prisma.agentRun.create({
      data: { wikiId: wiki.id, userId: user.id, type: "ingest", status: "running", input: { mode: "curate" } },
    });
    const conflictBuild = await builds.createIncrementalBuildForRun(
      conflictRun.id,
      wiki.id,
      user.id,
      targetRevision.id,
      { curateSourceRevisionId: targetRevision.id },
    );
    await prisma.knowledgeBuild.update({
      where: { id: conflictBuild.buildId },
      data: {
        status: "running",
        startedAt: new Date(),
        inputManifest: {
          sourceRevisionId: targetRevision.id,
          curateSourceRevisionId: targetRevision.id,
          inputs: [
            {
              sourceId: conflictTarget.source.id,
              sourceSlug: conflictTarget.source.slug,
              sourceRevisionId: targetRevision.id,
              version: conflictTarget.source.currentVersion,
              policyVersion: conflictTarget.source.policyVersion,
              contentHash: targetRevision.contentHash,
            },
            {
              sourceId: curatedSource.source.id,
              sourceSlug: curatedSource.source.slug,
              sourceRevisionId: unrelatedRevision.id,
              version: curatedSource.source.currentVersion,
              policyVersion: curatedSource.source.policyVersion,
              contentHash: unrelatedRevision.contentHash,
            },
          ],
        },
      },
    });
    const conflictBody = "agent replacement that must be staged as a conflict";
    const unrelatedBody = "unrelated source knowledge";
    await prisma.knowledgeDraft.createMany({
      data: [
        {
          buildId: conflictBuild.buildId,
          pageId: conflictTargetPage.page.id,
          baseVersion: conflictTargetPage.page.currentVersion,
          slug: conflictTargetPage.page.slug,
          status: "staged",
          title: conflictTargetPage.page.title,
          body: conflictBody,
          kind: "concept",
          contentHash: builds.knowledgeDraftHash({
            title: conflictTargetPage.page.title,
            body: conflictBody,
            kind: "concept",
            category: null,
            sourceRevisionIds: [targetRevision.id],
          }),
          validation: { ok: true },
        },
        {
          buildId: conflictBuild.buildId,
          slug: "unrelated-published-concept",
          status: "staged",
          title: "Unrelated Published Concept",
          body: unrelatedBody,
          kind: "concept",
          contentHash: builds.knowledgeDraftHash({
            title: "Unrelated Published Concept",
            body: unrelatedBody,
            kind: "concept",
            category: null,
            sourceRevisionIds: [unrelatedRevision.id],
          }),
          validation: { ok: true },
        },
      ],
    });
    const conflictDraftRows = await prisma.knowledgeDraft.findMany({
      where: { buildId: conflictBuild.buildId },
      orderBy: { slug: "asc" },
    });
    await prisma.knowledgeDraftSource.createMany({
      data: conflictDraftRows.map((draft) => ({
        draftId: draft.id,
        sourceRevisionId: draft.slug === conflictTargetPage.page.slug ? targetRevision.id : unrelatedRevision.id,
      })),
    });
    const conflictPublish = await builds.publishKnowledgeBuild(conflictBuild.buildId);
    assert.equal(conflictPublish.status, "review");
    assert.equal((await prisma.source.findUniqueOrThrow({ where: { id: conflictTarget.source.id } })).curationState, "preserved");
    // 이 Source가 훗날 다른 build로 curated되더라도 target draft가 conflict-only였던 옛 run을
    // promotion 성공으로 소급해서는 안 된다.
    await prisma.source.update({ where: { id: conflictTarget.source.id }, data: { curationState: "curated" } });
    await prisma.agentRun.update({ where: { id: conflictRun.id }, data: { status: "done", finishedAt: new Date() } });
    const conflictOnlyPromotionLink = await prisma.savedLink.create({
      data: {
        wikiId: wiki.id,
        userId: user.id,
        url: "https://example.com/conflict-only",
        title: "Conflict-only promotion",
        promotedRunId: conflictRun.id,
      },
    });
    const conflictOnlyPromotion = await promotion.promoteSavedLink(wiki.id, user.id, conflictOnlyPromotionLink.id);
    assert.equal(conflictOnlyPromotion.status, "done");
    assert.equal(conflictOnlyPromotion.promotedAt, null);
    assert.equal((await prisma.savedLink.findUniqueOrThrow({ where: { id: conflictOnlyPromotionLink.id } })).promotedAt, null);

    const preservedRevision = await prisma.sourceRevision.findUniqueOrThrow({
      where: { sourceId_version: { sourceId: preservedSource.id, version: preservedSource.currentVersion } },
    });
    const curateRun = await prisma.agentRun.create({
      data: { wikiId: wiki.id, userId: user.id, type: "ingest", status: "running", input: { sourceSlug: preservedSource.slug, mode: "curate" } },
    });
    const curateBuild = await builds.createIncrementalBuildForRun(
      curateRun.id,
      wiki.id,
      user.id,
      preservedRevision.id,
      { curateSourceRevisionId: preservedRevision.id },
    );
    const manifestItem = {
      sourceId: preservedSource.id,
      sourceSlug: preservedSource.slug,
      sourceRevisionId: preservedRevision.id,
      version: preservedSource.currentVersion,
      policyVersion: preservedSource.policyVersion,
      contentHash: preservedRevision.contentHash,
    };
    await prisma.knowledgeBuild.update({
      where: { id: curateBuild.buildId },
      data: {
        status: "running",
        startedAt: new Date(),
        inputManifest: {
          sourceRevisionId: preservedRevision.id,
          curateSourceRevisionId: preservedRevision.id,
          inputs: [manifestItem],
        },
      },
    });
    const curatedDraftBody = "PRESERVED_SCOPE_CANARY를 정리한 지식";
    await prisma.knowledgeDraft.create({
      data: {
        buildId: curateBuild.buildId,
        slug: "preserved-promoted-concept",
        status: "staged",
        title: "Preserved Promoted Concept",
        body: curatedDraftBody,
        kind: "concept",
        contentHash: builds.knowledgeDraftHash({
          title: "Preserved Promoted Concept",
          body: curatedDraftBody,
          kind: "concept",
          category: null,
          sourceRevisionIds: [preservedRevision.id],
        }),
        validation: { ok: true },
        sources: { create: { sourceRevisionId: preservedRevision.id } },
      },
    });
    const publishedCurate = await builds.publishKnowledgeBuild(curateBuild.buildId);
    assert.equal(publishedCurate.status, "published");
    assert.equal((await prisma.source.findUniqueOrThrow({ where: { id: preservedSource.id } })).curationState, "curated");
    assert.ok(await prisma.page.findUnique({ where: { wikiId_slug: { wikiId: wiki.id, slug: "preserved-promoted-concept" } } }));

    // 구 worker/crash 상태: 지식과 Source는 게시됐지만 run marker만 terminal/null로 갈라졌다면
    // promotion 재호출이 같은 runId를 유지하면서 실제 provenance를 기준으로 복구한다.
    await prisma.agentRun.update({ where: { id: curateRun.id }, data: { status: "done", finishedAt: new Date() } });
    const reconcileLink = await prisma.savedLink.create({
      data: {
        wikiId: wiki.id,
        userId: user.id,
        url: "https://example.com/reconcile",
        title: "Reconcile Link",
        promotedRunId: curateRun.id,
      },
    });
    const reconciledPromotion = await promotion.promoteSavedLink(wiki.id, user.id, reconcileLink.id);
    assert.equal(reconciledPromotion.runId, curateRun.id);
    assert.equal(reconciledPromotion.status, "done");
    assert.ok(reconciledPromotion.promotedAt);
    assert.ok((await prisma.savedLink.findUniqueOrThrow({ where: { id: reconcileLink.id } })).promotedAt);
    await prisma.agentRun.update({
      where: { id: curateRun.id },
      data: { status: "running", finishedAt: null },
    });
    const reconciledRunningPromotion = await promotion.promoteSavedLink(wiki.id, user.id, reconcileLink.id);
    assert.equal(reconciledRunningPromotion.runId, curateRun.id);
    assert.equal(reconciledRunningPromotion.status, "done");
    assert.ok((await prisma.agentRun.findUniqueOrThrow({ where: { id: curateRun.id } })).finishedAt);

    const defaultRun = await ingest.createIngestRun(wiki.id, { text: "default curate contract" }, user.id);
    const defaultRunRow = await prisma.agentRun.findUniqueOrThrow({ where: { id: defaultRun.id } });
    assert.equal((defaultRunRow.input as { mode?: string }).mode, "curate");
    await assert.rejects(
      ingest.createIngestRun(wiki.id, { text: "bad", mode: "archive" as never }, user.id),
      /유효하지 않은 ingest mode/,
    );

    const savedLink = await prisma.savedLink.create({
      data: { wikiId: wiki.id, userId: user.id, url: "https://example.com/retry", title: "Retry Link" },
    });
    const [promotionA, promotionB] = await Promise.all([
      promotion.promoteSavedLink(wiki.id, user.id, savedLink.id),
      promotion.promoteSavedLink(wiki.id, user.id, savedLink.id),
    ]);
    assert.equal(promotionA.runId, promotionB.runId);
    assert.equal(await prisma.agentRun.count({ where: { id: promotionA.runId ?? "" } }), 1);
    const promotedRow = await prisma.savedLink.findUniqueOrThrow({ where: { id: savedLink.id } });
    assert.equal(promotedRow.promotedAt, null);
    assert.equal(promotedRow.promotedRunId, promotionA.runId);

    const protectedPage = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "protected-title-canary",
      title: "PROTECTED_TITLE_CANARY",
      body: "PROTECTED_BODY_CANARY",
      kind: "personal",
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    await projections.refreshPageDerivedState(wiki.id, protectedPage.page.id);
    assert.equal((await search.modelSearch({
      trust: "external",
      wikiId: wiki.id,
      queryText: "PROTECTED_BODY_CANARY",
      k: 10,
      scope: "all",
    })).length, 0);
    assert.equal((await search.localFtsSearch(wiki.id, "PROTECTED_BODY_CANARY", 10, "protected"))
      .some((hit) => hit.refId === protectedPage.page.id), true);
    const protectedDocument = await content.createPageSnapshot({
      wikiId: wiki.id,
      slug: "protected-document-canary",
      title: "Protected Document Canary",
      body: "private document body",
      kind: "document",
      documentType: "general",
      documentAt: new Date("2026-07-21T03:00:00.000Z"),
      modelAccess: "internalOnly",
      context: { actor: "human", userId: user.id },
    });
    await assert.rejects(
      documents.appendDocument({
        wikiId: wiki.id,
        userId: user.id,
        actor: "agent",
        externalAgent: true,
        slug: protectedDocument.page.slug,
        content: "must not append",
        expectedVersion: protectedDocument.page.currentVersion,
      }),
      /page not found/,
    );
    const internalRun = await prisma.agentRun.create({
      data: {
        wikiId: wiki.id,
        userId: user.id,
        type: "ingest",
        status: "error",
        input: { modelAccess: "internalOnly" },
        output: { title: "PROTECTED_TITLE_CANARY", body: "PROTECTED_BODY_CANARY" },
        error: "PROTECTED_BODY_CANARY",
      },
    });

    const issued = await keys.createApiKey(user.id, "integration-scoped", {
      wikiId: wiki.id,
      maxRole: "editor",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const externalHeaders = {
      authorization: `Bearer ${issued.token}`,
    };
    const allowedGate = await apiGate.apiWikiGate(new Request("http://localhost" , { headers: externalHeaders }), wiki.slug);
    assert.equal(allowedGate.ok, true);
    if (allowedGate.ok) assert.equal(allowedGate.wiki.role, "editor");
    const deniedGate = await apiGate.apiWikiGate(new Request("http://localhost", { headers: externalHeaders }), otherWiki.slug);
    assert.equal(deniedGate.ok, false);
    if (!deniedGate.ok) assert.equal(deniedGate.res.status, 404);

    const categorySeed = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "agent",
      externalAgent: true,
      title: "Build Systems Folder Seed",
      body: "external category seed",
      documentType: "reference",
      category: "software-development/build-systems",
    });
    assert.equal(categorySeed.staged, false);

    const humanCategorized = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "human",
      externalAgent: false,
      title: "Human Categorized Document",
      body: "human category body",
      documentType: "reference",
      category: "software-development/build-systems",
    });
    assert.equal(humanCategorized.staged, false);
    if (humanCategorized.staged) throw new Error("unreachable");
    const stagedPlacementResponse = await documentsRoute.POST(
      new Request(`http://localhost/api/wikis/${wiki.slug}/documents`, {
        method: "POST",
        headers: { ...externalHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          slug: humanCategorized.page.slug,
          title: humanCategorized.page.title,
          body: `${humanCategorized.page.body}\n\nagent proposal`,
          expectedVersion: humanCategorized.page.currentVersion,
        }),
      }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    assert.equal(stagedPlacementResponse.status, 202);
    const stagedPlacement = await stagedPlacementResponse.json() as {
      staged: boolean;
      category: string | null;
      placement: { status: string; category: string | null; target: string };
    };
    assert.equal(stagedPlacement.staged, true);
    assert.equal(stagedPlacement.category, "software-development/build-systems");
    assert.deepEqual(stagedPlacement.placement, {
      status: "staged",
      requestedCategory: null,
      category: "software-development/build-systems",
      target: "category",
      reason: "unspecified",
    });

    const capturePayload = {
      title: "MSBuild와 CMake의 차이",
      body: "BUILD_CAPTURE_IDEMPOTENCY_CANARY",
      type: "reference",
      documentAt: "2026-08-06T09:00:00.000+09:00",
      category: "unknown/generated-folder",
      idempotencyKey: "build-comparison:2026-08-06",
    };
    const captureRequest = (payload: Record<string, unknown>) => documentsRoute.POST(
      new Request(`http://localhost/api/wikis/${wiki.slug}/documents`, {
        method: "POST",
        headers: { ...externalHeaders, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    const capturedResponse = await captureRequest(capturePayload);
    assert.equal(capturedResponse.status, 201);
    const captured = await capturedResponse.json() as {
      slug: string;
      origin: string;
      category: string | null;
      idempotentReplay: boolean;
      placement: { target: string; category: string | null; reason: string };
    };
    assert.equal(captured.origin, "generated", "Bearer without a trust header must still be an agent write");
    assert.equal(captured.category, null);
    assert.equal(captured.idempotentReplay, false);
    assert.deepEqual(captured.placement, {
      status: "stored",
      requestedCategory: "unknown/generated-folder",
      category: null,
      target: "inbox",
      reason: "category-unavailable-fallback-inbox",
    });
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { wikiId_slug: { wikiId: wiki.id, slug: captured.slug } } })).origin, "generated");

    const replayResponse = await captureRequest(capturePayload);
    assert.equal(replayResponse.status, 200);
    const replayed = await replayResponse.json() as { slug: string; idempotentReplay: boolean };
    assert.equal(replayed.slug, captured.slug);
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(await prisma.page.count({ where: { wikiId: wiki.id, slug: captured.slug } }), 1);

    const conflictResponse = await captureRequest({ ...capturePayload, body: "DIFFERENT_PAYLOAD" });
    assert.equal(conflictResponse.status, 409);
    assert.deepEqual(await conflictResponse.json(), { error: "idempotency_conflict" });

    const categoryConflictResponse = await captureRequest({
      ...capturePayload,
      category: "another/unknown-folder",
    });
    assert.equal(categoryConflictResponse.status, 409);
    assert.deepEqual(await categoryConflictResponse.json(), { error: "idempotency_conflict" });

    const concurrentPayload = {
      title: "Concurrent Capture",
      body: "CONCURRENT_CAPTURE_CANARY",
      idempotencyKey: "concurrent-capture:2026-08-06",
    };
    const concurrentResponses = await Promise.all(
      Array.from({ length: 6 }, () => captureRequest(concurrentPayload)),
    );
    assert.deepEqual(
      concurrentResponses.map((response) => response.status).sort(),
      [200, 200, 200, 200, 200, 201],
    );
    assert.equal(await prisma.page.count({ where: { wikiId: wiki.id, body: concurrentPayload.body } }), 1);

    const concurrentConflictPayload = {
      title: "Concurrent Placement Conflict",
      body: "CONCURRENT_PLACEMENT_CONFLICT_CANARY",
      category: "unknown/first-choice",
      idempotencyKey: "concurrent-placement-conflict:2026-08-06",
    };
    const concurrentConflictResponses = await Promise.all([
      captureRequest(concurrentConflictPayload),
      captureRequest({ ...concurrentConflictPayload, category: "unknown/second-choice" }),
    ]);
    assert.deepEqual(
      concurrentConflictResponses.map((response) => response.status).sort(),
      [201, 409],
    );
    assert.equal(
      await prisma.page.count({ where: { wikiId: wiki.id, body: concurrentConflictPayload.body } }),
      1,
    );

    const exactCategoryResponse = await captureRequest({
      title: "Compiler Build Notes",
      body: "exact existing category",
      type: "reference",
      category: "software-development/build-systems",
      requireCategory: true,
    });
    assert.equal(exactCategoryResponse.status, 201);
    const exactCategory = await exactCategoryResponse.json() as {
      category: string | null;
      placement: { reason: string; target: string };
    };
    assert.equal(exactCategory.category, "software-development/build-systems");
    assert.deepEqual(exactCategory.placement, {
      status: "stored",
      requestedCategory: "software-development/build-systems",
      category: "software-development/build-systems",
      target: "category",
      reason: "matched-existing-category",
    });

    const requiredMissingResponse = await captureRequest({
      title: "Must Stay In Requested Folder",
      body: "required category",
      category: "missing/explicit-folder",
      requireCategory: true,
    });
    assert.equal(requiredMissingResponse.status, 409);
    assert.deepEqual(await requiredMissingResponse.json(), { error: "category_not_available" });

    const generatedBeforeMetadataOmission = await prisma.page.findUniqueOrThrow({ where: { id: generated.page.id } });
    const metadataOmissionResponse = await documentsRoute.POST(
      new Request(`http://localhost/api/wikis/${wiki.slug}/documents`, {
        method: "POST",
        headers: { ...externalHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          slug: generatedBeforeMetadataOmission.slug,
          title: generatedBeforeMetadataOmission.title,
          body: `${generatedBeforeMetadataOmission.body}\n\nmetadata omitted update`,
          expectedVersion: generatedBeforeMetadataOmission.currentVersion,
        }),
      }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    assert.equal(metadataOmissionResponse.status, 200);
    const generatedAfterMetadataOmission = await prisma.page.findUniqueOrThrow({ where: { id: generated.page.id } });
    assert.equal(generatedAfterMetadataOmission.documentType, "plan");
    assert.equal(generatedAfterMetadataOmission.documentAt?.toISOString(), documentAtV2.toISOString());

    const invalidModeResponse = await ingestRoute.POST(
      new Request(`http://localhost/api/wikis/${wiki.slug}/ingest`, {
        method: "POST",
        headers: { ...externalHeaders, "content-type": "application/json" },
        body: JSON.stringify({ text: "bad mode", mode: "archive" }),
      }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    assert.equal(invalidModeResponse.status, 400);
    assert.deepEqual(await invalidModeResponse.json(), { error: "invalid_ingest_mode" });

    const allSearchResponse = await searchRoute.GET(
      new Request(`http://localhost/api/wikis/${wiki.slug}/search?q=SCOPE_CANARY&scope=all&k=10`, { headers: externalHeaders }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    assert.equal(allSearchResponse.status, 200);
    const allSearch = await allSearchResponse.json() as { groups?: { knowledge?: { hits?: unknown[] }; documents?: { hits?: unknown[] } } };
    assert.ok(Array.isArray(allSearch.groups?.knowledge?.hits));
    assert.ok(Array.isArray(allSearch.groups?.documents?.hits));

    const emptyAllSearchResponse = await searchRoute.GET(
      new Request(`http://localhost/api/wikis/${wiki.slug}/search?q=&scope=all`, { headers: externalHeaders }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    assert.deepEqual(await emptyAllSearchResponse.json(), {
      groups: { knowledge: { hits: [] }, documents: { hits: [] } },
    });

    const pagesResponse = await pagesRoute.GET(
      new Request(`http://localhost/api/wikis/${wiki.slug}/pages`, { headers: externalHeaders }),
      { params: Promise.resolve({ id: wiki.slug }) },
    );
    const pagesJson = JSON.stringify(await pagesResponse.json());
    assert.doesNotMatch(pagesJson, /PROTECTED_TITLE_CANARY|PROTECTED_BODY_CANARY/);
    const protectedResponse = await pageRoute.GET(
      new Request(`http://localhost/api/wikis/${wiki.slug}/pages/${protectedPage.page.slug}`, { headers: externalHeaders }),
      { params: Promise.resolve({ id: wiki.slug, pageSlug: protectedPage.page.slug }) },
    );
    assert.equal(protectedResponse.status, 404);
    const runResponse = await runRoute.GET(
      new Request(`http://localhost/api/wikis/${wiki.slug}/runs/${internalRun.id}`, { headers: externalHeaders }),
      { params: Promise.resolve({ id: wiki.slug, runId: internalRun.id }) },
    );
    const runJson = await runResponse.json() as { output?: unknown; error?: unknown };
    assert.equal(runJson.output, undefined);
    assert.equal(runJson.error, undefined);
    assert.doesNotMatch(JSON.stringify(runJson), /PROTECTED_TITLE_CANARY|PROTECTED_BODY_CANARY/);

    // 승격 run이 쿼터 때문에 preserve로 끝났다면 promotedAt 없이 error terminal이어야 하며,
    // 같은 runId를 재사용하는 호출자가 이를 성공으로 오해하지 않아야 한다.
    await prisma.usageEvent.create({
      data: { kind: "llm", route: "integration-quota", userId: user.id, wikiId: wiki.id, inputTokens: 3_000_000, outputTokens: 0 },
    });
    const blob = await import("../../src/lib/blob");
    deferredBlobKey = blob.makeStorageKey(wiki.id, "txt");
    await blob.getBlobStore().put(deferredBlobKey, Buffer.from("DEFERRED_BLOB_EXTRACTION_CANARY"));
    const deferredSource = await content.createSourceSnapshot({
      wikiId: wiki.id,
      slug: "deferred-blob-source",
      title: "Deferred Blob Source",
      body: null,
      storageKey: deferredBlobKey,
      curationState: "preserved",
      context: { actor: "human", userId: user.id },
    });
    const deferredRun = await prisma.agentRun.create({
      data: { wikiId: wiki.id, userId: user.id, type: "ingest", status: "pending", input: { sourceSlug: deferredSource.source.slug, mode: "curate" } },
    });
    await ingest.runClaimedIngestJob({
      id: deferredRun.id,
      wikiId: wiki.id,
      userId: user.id,
      input: { sourceSlug: deferredSource.source.slug, mode: "curate" },
    });
    const deferredAfter = await prisma.source.findUniqueOrThrow({ where: { id: deferredSource.source.id } });
    assert.equal(deferredAfter.body, "DEFERRED_BLOB_EXTRACTION_CANARY");
    assert.equal(deferredAfter.currentVersion, 2);
    assert.equal(deferredAfter.curationState, "preserved", "quota-blocked build must not mark deferred extraction curated");
    assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: deferredRun.id } })).status, "done");

    const failedPromotionRun = await prisma.agentRun.create({
      data: { wikiId: wiki.id, userId: user.id, type: "ingest", status: "pending", input: { text: "promotion quota source", mode: "curate" } },
    });
    const failedPromotionLink = await prisma.savedLink.create({
      data: {
        wikiId: wiki.id,
        userId: user.id,
        url: "https://example.com/quota-promotion",
        title: "Quota Promotion",
        promotedRunId: failedPromotionRun.id,
      },
    });
    await ingest.runClaimedIngestJob({
      id: failedPromotionRun.id,
      wikiId: wiki.id,
      userId: user.id,
      input: { text: "promotion quota source", mode: "curate" },
    });
    const failedPromotionState = await prisma.agentRun.findUniqueOrThrow({ where: { id: failedPromotionRun.id } });
    assert.equal(failedPromotionState.status, "error");
    assert.equal(failedPromotionState.error, "saved_link_promotion_not_curated");
    assert.equal((failedPromotionState.output as { outcome?: string }).outcome, "preserved");
    assert.equal((await prisma.savedLink.findUniqueOrThrow({ where: { id: failedPromotionLink.id } })).promotedAt, null);

    // v1 manifest는 당시 active Page 전체를 포함했다. document/personal이 들어 있는 옛 manifest를
    // 복원해도 새 KnowledgeBuild 관리 범위 밖 페이지는 되돌리거나 archive하지 않는다.
    const legacyPageRows = await prisma.page.findMany({
      where: { wikiId: wiki.id, archivedAt: null },
      include: { revisions: { orderBy: { version: "desc" }, take: 1 } },
      orderBy: { slug: "asc" },
    });
    const legacyManifestPages = legacyPageRows.map((page) => {
      const revision = page.revisions[0];
      assert.ok(revision);
      assert.equal(revision.version, page.currentVersion);
      return {
        pageId: page.id,
        slug: page.slug,
        pageRevisionId: revision.id,
        version: revision.version,
        contentHash: revision.contentHash,
      };
    });
    const legacyBuild = await prisma.knowledgeBuild.create({
      data: {
        wikiId: wiki.id,
        createdById: user.id,
        mode: "full",
        status: "published",
        publishedAt: new Date(),
        finishedAt: new Date(),
        publishedManifest: { pages: legacyManifestPages, relations: [] },
        relationManifest: [],
        restorable: true,
      },
    });
    const changedProtected = await content.updatePageSnapshot({
      wikiId: wiki.id,
      pageId: protectedPage.page.id,
      expectedVersion: protectedPage.page.currentVersion,
      changes: { body: "PROTECTED_BODY_AFTER_LEGACY_SNAPSHOT" },
      sourceRevisionIds: [],
      context: { actor: "human", userId: user.id },
    });
    const protectedDocumentCurrent = await prisma.page.findUniqueOrThrow({ where: { id: protectedDocument.page.id } });
    const changedProtectedDocument = await documents.writeDocument({
      wikiId: wiki.id,
      userId: user.id,
      actor: "human",
      externalAgent: false,
      slug: protectedDocumentCurrent.slug,
      title: protectedDocumentCurrent.title,
      body: "protected document after legacy snapshot",
      expectedVersion: protectedDocumentCurrent.currentVersion,
    });
    assert.equal(changedProtectedDocument.staged, false);
    await builds.restoreKnowledgeBuild(legacyBuild.id, user.id);
    const [protectedAfterRestore, protectedDocumentAfterRestore] = await Promise.all([
      prisma.page.findUniqueOrThrow({ where: { id: protectedPage.page.id } }),
      prisma.page.findUniqueOrThrow({ where: { id: protectedDocument.page.id } }),
    ]);
    assert.equal(protectedAfterRestore.currentVersion, changedProtected.page.currentVersion);
    assert.equal(protectedAfterRestore.body, "PROTECTED_BODY_AFTER_LEGACY_SNAPSHOT");
    if (changedProtectedDocument.staged) throw new Error("unreachable");
    assert.equal(protectedDocumentAfterRestore.currentVersion, changedProtectedDocument.page.currentVersion);
    assert.equal(protectedDocumentAfterRestore.body, "protected document after legacy snapshot");
  } finally {
    if (deferredBlobKey) {
      const blob = await import("../../src/lib/blob");
      await blob.getBlobStore().delete(deferredBlobKey);
    }
    await prisma.$disconnect();
  }
});
