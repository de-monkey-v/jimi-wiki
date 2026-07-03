import "dotenv/config";
import { prisma } from "../src/lib/db";
import { generateApiKey } from "../src/lib/apikey-core";

// 사용: pnpm apikey:issue "<이름>"
// DEV_USER_EMAIL 유저에게 API 키를 발급하고 토큰을 1회 출력한다.
async function main() {
  const name = process.argv[2] ?? "cli";
  // 2번째 인자로 email 지정 가능(테스트용 다른 계정). 기본은 DEV_USER_EMAIL.
  const email = (process.argv[3] ?? process.env.DEV_USER_EMAIL ?? "dev@jimi.local").toLowerCase();
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
  const g = generateApiKey();
  await prisma.apiKey.create({
    data: { userId: user.id, name: name.trim() || "cli", hashedKey: g.hashedKey, prefix: g.prefix },
  });
  console.log(`API 키 발급 완료 (이 토큰은 다시 볼 수 없습니다):\n`);
  console.log(`  이름:   ${name}`);
  console.log(`  prefix: ${g.prefix}`);
  console.log(`  TOKEN:  ${g.token}\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
