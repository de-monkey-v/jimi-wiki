// 기본 모델 ID 단일 출처(SSOT). env(CHAT_MODEL 등) 미설정 시 폴백값 + 매직 리터럴 제거용.
// 여기 외에는 코드 어디에도 모델 ID를 하드코딩하지 않는다.
export const DEFAULT_CHAT_MODEL = "gemini-2.5-flash"; // 채팅(스트리밍) 기본
export const DEFAULT_GEN_MODEL = "gemini-2.5-flash"; // query·lint 등 일반 생성 기본
export const DEFAULT_INGEST_MODEL = "gemini-3.1-pro-preview"; // ingest 에이전트 기본
export const DEFAULT_EMBED_MODEL = "gemini-embedding-001"; // 임베딩(검색·색인) 기본
export const DEFAULT_OPENAI_MODEL = "gpt-5.1"; // OpenAI 경로에서 모델 미지정 시 폴백
