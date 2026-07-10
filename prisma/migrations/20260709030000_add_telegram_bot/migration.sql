-- 텔레그램 봇: 채팅→위키 바인딩(TelegramBinding) + 대화 기억(TelegramTurn).
-- (Prisma diff가 pgvector HNSW 인덱스를 drift로 오인해 넣는 DROP INDEX는 의도적으로 제외 — restore_searchchunk_hnsw 참조.)

-- CreateTable
CREATE TABLE "TelegramBinding" (
    "chatId" TEXT NOT NULL,
    "wikiId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramBinding_pkey" PRIMARY KEY ("chatId")
);

-- CreateIndex
CREATE INDEX "TelegramBinding_wikiId_idx" ON "TelegramBinding"("wikiId");

-- AddForeignKey
ALTER TABLE "TelegramBinding" ADD CONSTRAINT "TelegramBinding_wikiId_fkey" FOREIGN KEY ("wikiId") REFERENCES "Wiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TelegramTurn" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramTurn_chatId_createdAt_idx" ON "TelegramTurn"("chatId", "createdAt");
