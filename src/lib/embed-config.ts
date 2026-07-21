/**
 * 임베딩 설정 — 검색 색인의 벡터 차원·프로바이더를 정하는 단일 소스.
 *
 * ⚠️ EMBED_DIM 은 DB의 `SearchChunk.embedding vector(N)` 컬럼·HNSW 인덱스와 결합돼 있다.
 *    바꾸려면 마이그레이션 + 전체 재색인이 필요하므로 프로바이더를 바꿔도 차원은 1024로 고정해 쓴다:
 *      - local(bge-m3): dense 차원이 1024 고정.
 *      - gemini(gemini-embedding-001): MRL 로 128~3072 임의 차원을 낼 수 있어 1024 도 가능하다.
 *        (3072 외 차원은 수동 L2 정규화가 필요한데, embedTexts 가 항상 정규화한다.)
 *    → 두 프로바이더가 같은 컬럼을 쓰므로, 되돌릴 때는 EMBED_PROVIDER 만 바꾸고 재색인하면 된다.
 *
 * server-only 를 붙이지 않는다: 순수 설정·문자열 가공만 있어 테스트에서 직접 import 한다.
 */
import { DEFAULT_EMBED_MODEL } from "@/lib/model-defaults";

export type EmbedProvider = "gemini" | "local";
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** bge-m3 등 self-host 모델의 기본값. TEI(text-embeddings-inference)가 이 모델을 서빙한다. */
export const DEFAULT_LOCAL_EMBED_MODEL = "BAAI/bge-m3";

/** 벡터 차원. DB 스키마와 결합돼 있어 env 로 낮추면 색인이 깨진다(마이그레이션 동반 필수). */
export const EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;

export function embedProvider(): EmbedProvider {
  const p = (process.env.EMBED_PROVIDER ?? "").trim().toLowerCase();
  if (p === "local" || p === "gemini") return p;
  // 미지정이면 로컬 엔드포인트가 설정된 경우에만 local — 기존 설치는 gemini 그대로 동작한다.
  return localEmbedBaseUrl() ? "local" : "gemini";
}

/** TEI 베이스 URL(끝 슬래시 제거). 없으면 null = local 프로바이더 사용 불가. */
export function localEmbedBaseUrl(): string | null {
  const raw = (process.env.EMBED_BASE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * 표시·계측용 모델명. local 은 TEI 가 실제로 무엇을 로드했는지와 무관한 라벨이다.
 *
 * EMBED_MODEL 이 지금 프로바이더와 안 맞으면(프로바이더만 바꾸고 모델명을 안 고친 흔한 경우)
 * 무시하고 기본값을 쓴다 — 그대로 두면 사용량 기록에 엉뚱한 모델이 남아 "무엇으로 색인했나"를
 * 나중에 판별할 수 없다. gemini-* 는 API 모델명, `org/model` 은 HF 저장소 id 로 구분한다.
 */
export function embedModelName(provider: EmbedProvider = embedProvider()): string {
  const explicit = (process.env.EMBED_MODEL ?? "").trim();
  const fitsProvider =
    provider === "local" ? !/^gemini-/i.test(explicit) : !explicit.includes("/");
  if (explicit && fitsProvider) return explicit;
  return provider === "local" ? DEFAULT_LOCAL_EMBED_MODEL : DEFAULT_EMBED_MODEL;
}

/**
 * bge-m3 는 query/passage 프리픽스(instruction)를 요구하지 않는다 — 모델 카드가 명시한다.
 * gemini 는 taskType 으로 비대칭 임베딩을 하므로 taskType 을 그대로 넘긴다.
 * 이 함수는 "프로바이더가 taskType 을 쓰는가"만 답한다(호출부는 taskType 을 항상 넘긴다).
 */
export function usesTaskType(provider: EmbedProvider = embedProvider()): boolean {
  return provider === "gemini";
}

/** TEI /embed 요청 본문. normalize 는 서버에서도 켜두고, 호출부에서 한 번 더 L2 정규화한다(멱등). */
export function teiEmbedRequest(texts: string[]): { inputs: string[]; normalize: boolean; truncate: boolean } {
  return { inputs: texts, normalize: true, truncate: true };
}

/**
 * TEI /embed 응답 파싱. 정상 응답은 float 배열의 배열이다.
 * 개수·차원이 어긋나면 조용히 잘못된 벡터를 쓰지 않고 즉시 실패시킨다(색인 오염 방지).
 */
export function parseTeiEmbedResponse(body: unknown, expectedCount: number, dim: number): number[][] {
  if (!Array.isArray(body)) throw new Error("임베딩 응답이 배열이 아닙니다");
  if (body.length !== expectedCount) {
    throw new Error(`임베딩 개수 불일치 ${body.length}/${expectedCount}`);
  }
  return body.map((v, i) => {
    if (!Array.isArray(v) || v.length === 0) throw new Error(`임베딩 ${i} 형식 오류`);
    if (v.length !== dim) throw new Error(`임베딩 차원 불일치 ${v.length}/${dim} (EMBED_DIM 설정 확인)`);
    return v as number[];
  });
}
