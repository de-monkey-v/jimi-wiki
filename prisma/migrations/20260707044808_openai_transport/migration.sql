-- OpenAI 연결 방식 명시적 선택으로 교체: openaiOAuth(Boolean) → openaiTransport(apikey|oauth|proxy)
ALTER TABLE "AppConfig" ADD COLUMN "openaiTransport" TEXT;
ALTER TABLE "AppConfig" DROP COLUMN "openaiOAuth";
