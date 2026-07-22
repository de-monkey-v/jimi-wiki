import "dotenv/config";
import { prisma } from "../src/lib/db";
import { authMode } from "../src/lib/auth-mode";
import { AUTH_TRANSITION_LOCK_ID } from "../src/lib/tailscale-auth-core";
import { assertManifestEqual, buildContentManifest, readManifest } from "./lib/content-manifest";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (authMode() !== "tailscale") throw new Error("AUTH_MODE=tailscale is required");
  if (option("--confirm") !== "RESET_JIMI_PERSONAL_AUTH") {
    throw new Error("Refusing reset: pass --confirm RESET_JIMI_PERSONAL_AUTH");
  }
  const manifestFile = option("--manifest");
  if (!manifestFile) throw new Error("--manifest <pre-reset manifest> is required");
  const expected = await readManifest(manifestFile);
  assertManifestEqual(await buildContentManifest(), expected);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTH_TRANSITION_LOCK_ID})`;
    const [accounts, sessions, verificationTokens, unusedInvites, revokedKeys] = await Promise.all([
      tx.account.deleteMany(),
      tx.session.deleteMany(),
      tx.verificationToken.deleteMany(),
      tx.invite.deleteMany({ where: { usedAt: null } }),
      tx.apiKey.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return {
      accounts: accounts.count,
      sessions: sessions.count,
      verificationTokens: verificationTokens.count,
      unusedInvites: unusedInvites.count,
      revokedKeys: revokedKeys.count,
    };
  });

  assertManifestEqual(await buildContentManifest(), expected);
  console.log(JSON.stringify({ ok: true, ...result }));
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
