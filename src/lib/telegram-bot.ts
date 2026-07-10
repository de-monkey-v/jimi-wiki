import "server-only";
import { prisma } from "@/lib/db";
import { getWikiForUser } from "@/lib/wiki";
import { BOT_USER_EMAIL } from "@/lib/telegram-config";
import { sendMessage, sendChatAction, parseCommand, type TgMessage } from "@/lib/telegram";
import { runWikiAgent } from "@/lib/wiki-agent";
import { appendTurn, loadHistory } from "@/lib/bot-conversation";

const HELP = [
  "지미 위키 봇입니다. 이 채팅을 위키에 연결하면 자연어로 묻고 자료를 넣을 수 있어요.",
  "",
  "/bind <위키-slug> — 이 채팅을 위키에 연결",
  "/whoami — 현재 연결된 위키 확인",
  "/unbind — 연결 해제",
  "/help — 도움말",
  "",
  "연결 후:",
  "· 그냥 질문하면 위키 근거로 답합니다(찾기).",
  "· URL이나 붙여넣은 텍스트를 주면 편입합니다(넣기). 완료되면 알려드려요.",
].join("\n");

// 봇 User id 캐시(이메일→id는 불변). 시드 전이면 null 유지 후 재조회.
let botUserIdCache: string | null = null;
async function getBotUserId(): Promise<string | null> {
  if (botUserIdCache) return botUserIdCache;
  const u = await prisma.user.findUnique({ where: { email: BOT_USER_EMAIL }, select: { id: true } });
  botUserIdCache = u?.id ?? null;
  return botUserIdCache;
}

// ---------- 바인딩 ----------
export function getBinding(chatId: string) {
  return prisma.telegramBinding.findUnique({ where: { chatId } });
}
function setBinding(chatId: string, wikiId: string, createdById: string | null) {
  return prisma.telegramBinding.upsert({
    where: { chatId },
    update: { wikiId, createdById },
    create: { chatId, wikiId, createdById },
  });
}
function removeBinding(chatId: string) {
  return prisma.telegramBinding.deleteMany({ where: { chatId } });
}

// ---------- 업데이트 처리(진입점) ----------
/** 정규화된 텔레그램 메시지를 처리하고 필요한 응답을 직접 전송한다. 예외는 밖으로 던지지 않는다(웹훅 200 유지). */
export async function handleTelegramUpdate(msg: TgMessage): Promise<void> {
  try {
    const cmd = parseCommand(msg.text);
    if (cmd) return await handleCommand(msg, cmd.cmd, cmd.args);
    return await handleMessage(msg);
  } catch (e) {
    console.error("[telegram] 처리 오류:", (e as Error)?.message);
    await sendMessage(msg.chatId, "처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.").catch(() => {});
  }
}

async function handleCommand(msg: TgMessage, cmd: string, args: string): Promise<void> {
  switch (cmd) {
    case "start":
    case "help":
      return void (await sendMessage(msg.chatId, HELP));
    case "bind":
    case "use": {
      const slug = args.trim();
      if (!slug) return void (await sendMessage(msg.chatId, "사용법: /bind <위키-slug>"));
      const botId = await getBotUserId();
      if (!botId) return void (await sendMessage(msg.chatId, "봇 계정이 아직 준비되지 않았습니다. 관리자에게 문의하세요(telegram:seed)."));
      const wiki = await getWikiForUser(botId, slug);
      if (!wiki) {
        return void (await sendMessage(msg.chatId, `'${slug}' 위키에 연결할 수 없어요. 봇이 그 위키의 멤버가 아닙니다(관리자가 봇을 editor로 추가해야 합니다).`));
      }
      await setBinding(msg.chatId, wiki.id, msg.fromId);
      return void (await sendMessage(msg.chatId, `이 채팅을 "${wiki.title}" 위키에 연결했어요. 이제 질문하거나 URL·텍스트를 보내보세요.`));
    }
    case "whoami":
    case "status": {
      const b = await getBinding(msg.chatId);
      if (!b) return void (await sendMessage(msg.chatId, "아직 연결된 위키가 없어요. /bind <위키-slug>"));
      const wiki = await prisma.wiki.findUnique({ where: { id: b.wikiId }, select: { slug: true, title: true } });
      return void (await sendMessage(msg.chatId, wiki ? `연결됨: "${wiki.title}" (${wiki.slug})` : "연결된 위키를 찾을 수 없어요. /unbind 후 다시 /bind 해주세요."));
    }
    case "unbind":
      await removeBinding(msg.chatId);
      return void (await sendMessage(msg.chatId, "연결을 해제했어요."));
    default:
      return void (await sendMessage(msg.chatId, `알 수 없는 명령입니다: /${cmd}\n${HELP}`));
  }
}

async function handleMessage(msg: TgMessage): Promise<void> {
  const binding = await getBinding(msg.chatId);
  if (!binding) {
    return void (await sendMessage(msg.chatId, "먼저 이 채팅을 위키에 연결해 주세요: /bind <위키-slug>"));
  }
  const botId = await getBotUserId();
  await sendChatAction(msg.chatId, "typing");

  const history = await loadHistory(msg.chatId);
  const { answer } = await runWikiAgent({
    wikiId: binding.wikiId,
    userId: botId,
    chatId: msg.chatId,
    userMessage: msg.text,
    history,
  });
  // 대화 기억 갱신(사용자 발화 + 봇 응답).
  await appendTurn(msg.chatId, "user", msg.text);
  await appendTurn(msg.chatId, "model", answer);
  await sendMessage(msg.chatId, answer);
}
