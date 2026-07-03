import "dotenv/config";
import { prisma } from "../src/lib/db";

// 개발용 테스트 계정. OAuth 붙이기 전까지 이 유저가 "로그인된 사용자".
async function main() {
  const email = process.env.DEV_USER_EMAIL ?? "dev@jimi.local";
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Dev User", emailVerified: new Date() },
  });
  console.log(`seed: dev user ready → ${user.email} (${user.id})`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
