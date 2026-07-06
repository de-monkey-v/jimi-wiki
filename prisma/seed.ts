import "dotenv/config";
import { hash } from "@node-rs/argon2";
import { prisma } from "../src/lib/db";

// first-run 관리자 부트스트랩(헤드리스 배포용). ADMIN_EMAIL/ADMIN_PASSWORD가 있고
// 비밀번호를 가진 관리자가 아직 0명일 때만 시드한다. /setup 웹 플로우의 대안.
async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("seed: ADMIN_EMAIL/ADMIN_PASSWORD 미설정 — /setup 에서 관리자를 만드세요");
    return;
  }
  const existing = await prisma.user.count({ where: { passwordHash: { not: null } } });
  if (existing > 0) {
    console.log("seed: 비밀번호 관리자가 이미 존재 — 건너뜀");
    return;
  }
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, isAdmin: true },
    create: { email, passwordHash, isAdmin: true, name: "Admin", emailVerified: new Date() },
  });
  console.log(`seed: admin ready → ${user.email}`);
}

main()
  .catch(async (e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
