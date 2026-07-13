import "dotenv/config";
import { prisma } from "../src/lib/db";
import { getBlobStore } from "../src/lib/blob";
import { createPageSnapshot, createSourceSnapshot } from "../src/lib/content-store";
import { refreshPageDerivedState, refreshSourceDerivedState } from "../src/lib/page-projections";

const REQUIRED_CONFIRMATION = "RESET-WIKI-CONTENT";
const CANARY = "JIMI_INTERNAL_CANARY_FICTIONAL_7K4Q9X2";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function assertLocalDatabase(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL이 필요합니다");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`로컬 DB만 초기화할 수 있습니다(host=${url.hostname})`);
  }
  if (arg("confirm") !== REQUIRED_CONFIRMATION) {
    throw new Error(`--confirm=${REQUIRED_CONFIRMATION} 확인값이 필요합니다`);
  }
  return url;
}

async function resolveOwner(): Promise<{ id: string; email: string }> {
  const requested = arg("owner-email")?.trim().toLowerCase();
  if (requested) {
    const owner = await prisma.user.findUnique({ where: { email: requested }, select: { id: true, email: true } });
    if (!owner) throw new Error(`--owner-email 사용자를 찾을 수 없습니다: ${requested}`);
    return owner;
  }
  const admins = await prisma.user.findMany({ where: { isAdmin: true }, select: { id: true, email: true } });
  if (admins.length !== 1) {
    throw new Error(`admin이 정확히 한 명이 아닙니다(${admins.length}). --owner-email을 지정하세요`);
  }
  return admins[0];
}

async function createFixture(owner: { id: string; email: string }) {
  const wiki = await prisma.wiki.create({
    data: {
      slug: "jimi-rebuild-lab",
      title: "Jimi Rebuild Lab",
      description: "Revision, rebuild, conflict, and model-access development fixture",
      visibility: "private",
      kind: "project",
      createdById: owner.id,
      memberships: { create: { userId: owner.id, role: "owner" } },
    },
  });

  const external = await createSourceSnapshot({
    wikiId: wiki.id,
    slug: "external-revision-ledger",
    title: "External Revision Ledger",
    body:
      "A revision ledger stores immutable full snapshots. A knowledge build stages extracted claims before publishing. " +
      "The stable concept revision-ledger should explain append-only history and provenance.",
    modelAccess: "external",
    context: { actor: "human", userId: owner.id, reason: "reset-test-content external fixture" },
  });
  const internal = await createSourceSnapshot({
    wikiId: wiki.id,
    slug: "internal-canary",
    title: "Fictional Internal Canary",
    body: `${CANARY} is synthetic test data. It is not a real person, credential, account, or secret.`,
    modelAccess: "internalOnly",
    context: { actor: "human", userId: owner.id, reason: "reset-test-content internal canary" },
  });

  const human = await createPageSnapshot({
    wikiId: wiki.id,
    slug: "human-notes",
    title: "Human Notes",
    kind: "concept",
    body: "This page is written by a human and must never be overwritten automatically.",
    origin: "human",
    modelAccess: "external",
    context: { actor: "human", userId: owner.id, reason: "reset-test-content human fixture" },
  });
  const conflict = await createPageSnapshot({
    wikiId: wiki.id,
    slug: "revision-ledger",
    title: "Revision Ledger — Human Version",
    kind: "concept",
    body: "Human-owned collision target. Generated synthesis must remain a review draft.",
    origin: "human",
    modelAccess: "external",
    context: { actor: "human", userId: owner.id, reason: "reset-test-content conflict fixture" },
  });
  const generated = await createPageSnapshot({
    wikiId: wiki.id,
    slug: "legacy-generated",
    title: "Legacy Generated Page",
    kind: "concept",
    body: "A generated page used to verify full-build stale archival.",
    origin: "generated",
    modelAccess: "external",
    sourceRevisionIds: [external.revision.id],
    context: { actor: "agent", userId: owner.id, reason: "reset-test-content generated fixture" },
  });
  const internalNote = await createPageSnapshot({
    wikiId: wiki.id,
    slug: "internal-canary",
    title: "Fictional Internal Canary",
    kind: "note",
    body: `로컬 전용 테스트 원문입니다. ${CANARY}`,
    origin: "generated",
    modelAccess: "internalOnly",
    sourceId: internal.source.id,
    sourceRevisionIds: [internal.revision.id],
    context: { actor: "agent", userId: owner.id, reason: "reset-test-content internal note" },
  });

  await Promise.all([
    refreshSourceDerivedState(wiki.id, external.source.id),
    refreshSourceDerivedState(wiki.id, internal.source.id),
    refreshPageDerivedState(wiki.id, human.page.id),
    refreshPageDerivedState(wiki.id, conflict.page.id),
    refreshPageDerivedState(wiki.id, generated.page.id),
    refreshPageDerivedState(wiki.id, internalNote.page.id),
  ]);
  return { wiki, external, internal, pages: [human.page, conflict.page, generated.page, internalNote.page] };
}

async function main() {
  const database = assertLocalDatabase();
  const owner = await resolveOwner();
  const existingWikis = await prisma.wiki.findMany({ select: { id: true } });
  const wikiIds = existingWikis.map((wiki) => wiki.id);

  // DB transaction과 파일 삭제는 원자화할 수 없으므로 blob을 먼저 제거한다. 확인값·owner 검증은 이미 끝났다.
  const blobs = getBlobStore();
  for (const wikiId of wikiIds) await blobs.deletePrefix(`${wikiId}/`);
  await prisma.$transaction(async (tx) => {
    if (wikiIds.length) await tx.usageEvent.deleteMany({ where: { wikiId: { in: wikiIds } } });
    await tx.wiki.deleteMany();
  });
  const fixture = await createFixture(owner);
  console.log(JSON.stringify({
    database: `${database.hostname}:${database.port || "5432"}/${database.pathname.slice(1)}`,
    owner: owner.email,
    wiki: fixture.wiki.slug,
    externalSource: fixture.external.source.slug,
    internalSource: fixture.internal.source.slug,
    canary: CANARY,
    pages: fixture.pages.map((page) => page.slug),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
