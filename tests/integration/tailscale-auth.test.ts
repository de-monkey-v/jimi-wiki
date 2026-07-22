import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

function assertIsolatedLocalDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("integration test requires explicit DATABASE_URL");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error(`integration test refuses non-local DB host: ${url.hostname}`);
  if (process.env.JIMI_INTEGRATION_CONFIRM !== "ISOLATED-DB") throw new Error("integration test requires JIMI_INTEGRATION_CONFIRM=ISOLATED-DB");
  return raw;
}

test("Tailscale claim, scoped Hermes key rotation, and auth reset preserve content", async () => {
  const databaseUrl = assertIsolatedLocalDatabase();
  const temp = await mkdtemp(path.join(os.tmpdir(), "jimi-tailscale-auth-"));
  const login = "owner@example.invalid";
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BLOB_DIR: path.join(temp, "blobs"),
    AUTH_MODE: "tailscale",
    TAILSCALE_ALLOWED_LOGIN: login,
  };
  const [{ prisma }, keys, gate, tailscale, manifest] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/apikey"),
    import("../../src/lib/api-gate"),
    import("../../src/lib/tailscale-auth"),
    import("../../scripts/lib/content-manifest"),
  ]);

  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AppConfig", "UsageEvent", "User" RESTART IDENTITY CASCADE');
    const owner = await prisma.user.create({ data: { email: login, isAdmin: true } });
    const personal = await prisma.wiki.create({
      data: { slug: "personal", title: "Personal", kind: "personal", createdById: owner.id, memberships: { create: { userId: owner.id, role: "owner" } } },
    });
    const project = await prisma.wiki.create({
      data: { slug: "project", title: "Project", kind: "project", createdById: owner.id, memberships: { create: { userId: owner.id, role: "owner" } } },
    });
    const page = await prisma.page.create({ data: { wikiId: personal.id, slug: "preserved", title: "Preserved", body: "content" } });
    const saved = await prisma.savedLink.create({ data: { wikiId: personal.id, userId: owner.id, url: "https://example.com/preserved", title: "Preserved" } });
    await prisma.invite.createMany({ data: [
      { token: "used-invite", createdById: owner.id, usedAt: new Date(), usedByUserId: owner.id },
      { token: "unused-invite", createdById: owner.id },
    ] });
    const oldKey = await keys.createApiKey(owner.id, "old-key", { wikiId: personal.id, maxRole: "editor" });
    const before = await manifest.buildContentManifest({ databaseUrl, blobDir: env.BLOB_DIR });
    const manifestFile = path.join(temp, "before.json");
    await manifest.writeManifest(manifestFile, before);

    const reset = await execFileAsync(process.execPath, [
      "--require", "./scripts/server-only-shim.cjs", "--import", "tsx", "./scripts/reset-personal-auth.ts",
      "--manifest", manifestFile, "--confirm", "RESET_JIMI_PERSONAL_AUTH",
    ], { cwd: process.cwd(), env });
    assert.match(reset.stdout, /"ok":true/);
    assert.equal(await prisma.account.count(), 0);
    assert.equal(await prisma.session.count(), 0);
    assert.equal(await prisma.verificationToken.count(), 0);
    assert.equal(await prisma.invite.count({ where: { token: "unused-invite" } }), 0);
    assert.equal(await prisma.invite.count({ where: { token: "used-invite" } }), 1);
    assert.ok((await prisma.apiKey.findUniqueOrThrow({ where: { id: oldKey.id } })).revokedAt);
    assert.equal(await keys.getApiAuth(new Request("http://localhost", { headers: { Authorization: `Bearer ${oldKey.token}` } })), null);
    manifest.assertManifestEqual(await manifest.buildContentManifest({ databaseUrl, blobDir: env.BLOB_DIR }), before);
    assert.equal((await prisma.page.findUniqueOrThrow({ where: { id: page.id } })).body, "content");
    assert.equal((await prisma.savedLink.findUniqueOrThrow({ where: { id: saved.id } })).userId, owner.id);

    const claimed = await Promise.all([
      tailscale.claimTailscaleOwner(login),
      tailscale.claimTailscaleOwner(login),
    ]);
    assert.deepEqual(claimed.map((user) => user.id), [owner.id, owner.id]);
    assert.equal(await prisma.account.count({ where: { provider: "tailscale" } }), 1);

    const hermesEnv = path.join(temp, "hermes.env");
    await writeFile(hermesEnv, "JIMI_WIKI_PERSONAL_KEY=old\n", { mode: 0o600 });
    const issue = await execFileAsync(process.execPath, [
      "--require", "./scripts/server-only-shim.cjs", "--import", "tsx", "./scripts/issue-hermes-key.ts",
      "--env-file", hermesEnv, "--wiki", personal.slug, "--confirm", "ROTATE_HERMES_PERSONAL_KEY",
    ], { cwd: process.cwd(), env });
    assert.match(issue.stdout, /"ok":true/);
    const token = (await readFile(hermesEnv, "utf8")).match(/^JIMI_WIKI_PERSONAL_KEY=(.+)$/m)?.[1];
    assert.ok(token && token !== "old");
    const record = await prisma.apiKey.findFirstOrThrow({ where: { name: "hermes-personal", revokedAt: null } });
    assert.equal(record.wikiId, personal.id);
    assert.equal(record.maxRole, "editor");
    assert.ok(record.expiresAt);
    assert.ok(Math.abs(record.expiresAt.getTime() - (Date.now() + 90 * 86_400_000)) < 60_000);

    const request = new Request("http://localhost", { headers: { Authorization: `Bearer ${token}` } });
    const personalGate = await gate.apiWikiGate(request, personal.slug, { minRole: "editor" });
    assert.equal(personalGate.ok, true);
    if (personalGate.ok) assert.equal(personalGate.wiki.role, "editor");
    const projectGate = await gate.apiWikiGate(request, project.slug);
    assert.equal(projectGate.ok, false);
    if (!projectGate.ok) assert.equal(projectGate.res.status, 404);
    const ownerGate = await gate.apiWikiGate(request, personal.slug, { minRole: "owner" });
    assert.equal(ownerGate.ok, false);
    if (!ownerGate.ok) assert.equal(ownerGate.res.status, 403);

    await prisma.account.deleteMany();
    const second = await prisma.user.create({ data: { email: "second@example.invalid" } });
    await prisma.membership.create({ data: { wikiId: project.id, userId: second.id, role: "owner" } });
    await assert.rejects(() => tailscale.claimTailscaleOwner(login), (error: unknown) =>
      error instanceof tailscale.TailscaleClaimError && error.code === "recovery-required");
    assert.equal(await prisma.account.count({ where: { provider: "tailscale" } }), 0);

    await prisma.membership.updateMany({ data: { role: "editor" } });
    await assert.rejects(() => tailscale.claimTailscaleOwner(login), (error: unknown) =>
      error instanceof tailscale.TailscaleClaimError && error.code === "recovery-required");
    assert.equal(await prisma.account.count({ where: { provider: "tailscale" } }), 0);
  } finally {
    await prisma.$disconnect();
    await rm(temp, { recursive: true, force: true });
  }
});
