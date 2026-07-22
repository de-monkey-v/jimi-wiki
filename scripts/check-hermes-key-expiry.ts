import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const warningAt = new Date(Date.now() + 14 * 86_400_000);
  const keys = await prisma.apiKey.findMany({
    where: { name: "hermes-personal", revokedAt: null, expiresAt: { lte: warningAt } },
    select: { prefix: true, expiresAt: true, wiki: { select: { slug: true } } },
  });
  if (keys.length > 0) {
    for (const key of keys) console.error(`Hermes API key ${key.prefix}… (${key.wiki?.slug ?? "unscoped"}) expires at ${key.expiresAt?.toISOString()}`);
    process.exitCode = 1;
  } else {
    console.log("Hermes API key expiry check OK");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
