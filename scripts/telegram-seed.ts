import "dotenv/config";
import { prisma } from "../src/lib/db";
import { BOT_USER_EMAIL } from "../src/lib/telegram-config";

// 사용: npm run telegram:seed [<wiki-slug> ...]
// 서비스 계정(봇 User)을 멱등 생성하고, 인자로 준 위키 slug들에 editor 멤버십을 부여한다.
// 봇은 멤버인 위키만 /bind 로 열 수 있으므로, 여기서 봇에 노출할 위키를 통제한다.
async function main() {
  const slugs = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);

  const bot = await prisma.user.upsert({
    where: { email: BOT_USER_EMAIL },
    update: {},
    create: { email: BOT_USER_EMAIL, name: "Telegram Bot" }, // passwordHash 없음 = 로그인 불가 서비스 계정
  });
  console.log(`봇 User 준비됨: ${bot.email} (id=${bot.id})`);

  for (const slug of slugs) {
    const wiki = await prisma.wiki.findUnique({ where: { slug }, select: { id: true, title: true } });
    if (!wiki) {
      console.warn(`  ⚠ 위키 없음, 건너뜀: ${slug}`);
      continue;
    }
    await prisma.membership.upsert({
      where: { wikiId_userId: { wikiId: wiki.id, userId: bot.id } },
      update: { role: "editor" },
      create: { wikiId: wiki.id, userId: bot.id, role: "editor" },
    });
    console.log(`  ✓ 멤버십(editor) 부여: ${slug} — "${wiki.title}"`);
  }

  if (slugs.length === 0) {
    console.log("(위키 slug를 인자로 주면 그 위키에 봇 editor 멤버십을 부여합니다: npm run telegram:seed my-wiki)");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
