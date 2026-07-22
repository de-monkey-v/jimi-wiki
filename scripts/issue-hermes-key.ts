import "dotenv/config";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { generateApiKey } from "../src/lib/apikey-core";
import { authMode } from "../src/lib/auth-mode";
import { AUTH_TRANSITION_LOCK_ID, TAILSCALE_PROVIDER } from "../src/lib/tailscale-auth-core";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeProtectedFile(absolute: string, contents: string) {
  const temp = `${absolute}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, absolute);
}

async function replaceEnvValue(absolute: string, current: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(current) ? current.replace(pattern, line) : `${current.replace(/\n?$/, "\n")}${line}\n`;
  await writeProtectedFile(absolute, next);
}

async function main() {
  if (authMode() !== "tailscale") throw new Error("AUTH_MODE=tailscale is required");
  if (option("--confirm") !== "ROTATE_HERMES_PERSONAL_KEY") {
    throw new Error("Refusing key rotation: pass --confirm ROTATE_HERMES_PERSONAL_KEY");
  }
  const envFile = option("--env-file");
  if (!envFile) throw new Error("--env-file <Hermes personal .env> is required");
  const login = process.env.TAILSCALE_ALLOWED_LOGIN;
  if (!login) throw new Error("TAILSCALE_ALLOWED_LOGIN is required");
  const wikiSlug = option("--wiki");
  const generated = generateApiKey();
  const expiresAt = new Date(Date.now() + 90 * 86_400_000);
  const absoluteEnvFile = path.resolve(envFile);
  let previousEnv: string | undefined;
  let envWritten = false;

  let record;
  try {
    record = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTH_TRANSITION_LOCK_ID})`;
      const account = await tx.account.findUnique({
        where: { provider_providerAccountId: { provider: TAILSCALE_PROVIDER, providerAccountId: login } },
      });
      if (!account) throw new Error("Complete the Tailscale owner claim first");
      const memberships = await tx.membership.findMany({
        where: { userId: account.userId, role: { in: ["owner", "editor"] }, wiki: { kind: "personal", trashedAt: null, ...(wikiSlug ? { slug: wikiSlug } : {}) } },
        select: { wiki: { select: { id: true, slug: true } } },
      });
      if (memberships.length !== 1) throw new Error("Exactly one writable personal wiki must match; pass --wiki when needed");
      previousEnv = await readFile(absoluteEnvFile, "utf8");
      const created = await tx.apiKey.create({
        data: {
          userId: account.userId,
          wikiId: memberships[0].wiki.id,
          name: "hermes-personal",
          hashedKey: generated.hashedKey,
          prefix: generated.prefix,
          maxRole: "editor",
          expiresAt,
        },
        select: { id: true, userId: true, prefix: true, expiresAt: true, wiki: { select: { slug: true } } },
      });
      await replaceEnvValue(absoluteEnvFile, previousEnv, "JIMI_WIKI_PERSONAL_KEY", generated.token);
      envWritten = true;
      await tx.apiKey.updateMany({
        where: { userId: account.userId, name: "hermes-personal", revokedAt: null, id: { not: created.id } },
        data: { revokedAt: new Date() },
      });
      return created;
    }, { maxWait: 15_000, timeout: 15_000 });
  } catch (error) {
    if (envWritten && previousEnv !== undefined) {
      try {
        await writeProtectedFile(absoluteEnvFile, previousEnv);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Key rotation failed and the Hermes env rollback also failed");
      }
    }
    throw error;
  }
  console.log(JSON.stringify({ ok: true, prefix: record.prefix, wiki: record.wiki?.slug, expiresAt: record.expiresAt, envFile: absoluteEnvFile }));
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
