import "dotenv/config";
import { prisma } from "../src/lib/db";
import { authMode } from "../src/lib/auth-mode";
import { AUTH_TRANSITION_LOCK_ID, TAILSCALE_PROVIDER } from "../src/lib/tailscale-auth-core";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (authMode() !== "tailscale") throw new Error("AUTH_MODE=tailscale is required");
  if (option("--confirm") !== "ATTACH_TAILSCALE_ACCOUNT") {
    throw new Error("Refusing recovery: pass --confirm ATTACH_TAILSCALE_ACCOUNT");
  }
  const userId = option("--user-id");
  const login = option("--login");
  if (!userId || !login) throw new Error("--user-id and --login are required");
  if (login !== process.env.TAILSCALE_ALLOWED_LOGIN) throw new Error("--login must exactly match TAILSCALE_ALLOWED_LOGIN");

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTH_TRANSITION_LOCK_ID})`;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isAdmin: true, _count: { select: { memberships: { where: { role: "owner" } }, createdWikis: true } } },
    });
    if (!user) throw new Error("User not found");
    const existing = await tx.account.findUnique({
      where: { provider_providerAccountId: { provider: TAILSCALE_PROVIDER, providerAccountId: login } },
    });
    if (existing && existing.userId !== userId) throw new Error("Tailscale login is already mapped to another User");
    const other = await tx.account.findFirst({ where: { provider: TAILSCALE_PROVIDER, providerAccountId: { not: login } } });
    if (other) throw new Error("A different Tailscale login mapping exists; refusing automatic replacement");
    if (!existing) {
      await tx.account.create({ data: { userId, type: TAILSCALE_PROVIDER, provider: TAILSCALE_PROVIDER, providerAccountId: login } });
    }
    return { userId: user.id, email: user.email, ownerMemberships: user._count.memberships, createdWikis: user._count.createdWikis, isAdmin: user.isAdmin, idempotent: Boolean(existing) };
  });
  console.log(JSON.stringify({ ok: true, ...result }));
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
