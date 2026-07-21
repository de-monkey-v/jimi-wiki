import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCAL_EMBED_MODEL,
  embedModelName,
  embedProvider,
  localEmbedBaseUrl,
  parseTeiEmbedResponse,
  teiEmbedRequest,
  usesTaskType,
} from "./embed-config";

// env 를 만졌다 되돌리는 헬퍼(테스트 간 오염 방지).
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("embedProvider: 명시값 우선, 미지정이면 EMBED_BASE_URL 유무로 결정", () => {
  withEnv({ EMBED_PROVIDER: "local", EMBED_BASE_URL: undefined }, () => {
    assert.equal(embedProvider(), "local"); // 명시했으면 URL 이 없어도 local(=설정 실수를 숨기지 않음)
  });
  withEnv({ EMBED_PROVIDER: "gemini", EMBED_BASE_URL: "http://x:8080" }, () => {
    assert.equal(embedProvider(), "gemini");
  });
  // 미지정: 기존 설치(URL 없음)는 gemini 그대로, URL 만 준 경우는 local
  withEnv({ EMBED_PROVIDER: undefined, EMBED_BASE_URL: undefined }, () => {
    assert.equal(embedProvider(), "gemini");
  });
  withEnv({ EMBED_PROVIDER: undefined, EMBED_BASE_URL: "http://x:8080" }, () => {
    assert.equal(embedProvider(), "local");
  });
  // 오타/알 수 없는 값은 미지정과 같게 취급
  withEnv({ EMBED_PROVIDER: "ollama", EMBED_BASE_URL: undefined }, () => {
    assert.equal(embedProvider(), "gemini");
  });
});

test("localEmbedBaseUrl: 끝 슬래시를 제거하고, 비어 있으면 null", () => {
  withEnv({ EMBED_BASE_URL: "http://embeddings:80/" }, () => {
    assert.equal(localEmbedBaseUrl(), "http://embeddings:80");
  });
  withEnv({ EMBED_BASE_URL: "http://embeddings:80///" }, () => {
    assert.equal(localEmbedBaseUrl(), "http://embeddings:80");
  });
  withEnv({ EMBED_BASE_URL: "   " }, () => {
    assert.equal(localEmbedBaseUrl(), null);
  });
});

test("embedModelName: EMBED_MODEL 이 있으면 그 값, 없으면 프로바이더별 기본값", () => {
  withEnv({ EMBED_MODEL: "nlpai-lab/KURE-v1" }, () => {
    assert.equal(embedModelName("local"), "nlpai-lab/KURE-v1");
  });
  withEnv({ EMBED_MODEL: undefined }, () => {
    assert.equal(embedModelName("local"), DEFAULT_LOCAL_EMBED_MODEL);
    assert.match(embedModelName("gemini"), /^gemini-/);
  });
});

test("embedModelName: 프로바이더와 안 맞는 EMBED_MODEL 은 무시한다(사용량 기록 오염 방지)", () => {
  // gemini 로 쓰다가 local 로 바꾸면서 EMBED_MODEL 을 안 고친 흔한 경우
  withEnv({ EMBED_MODEL: "gemini-embedding-001" }, () => {
    assert.equal(embedModelName("local"), DEFAULT_LOCAL_EMBED_MODEL);
    assert.equal(embedModelName("gemini"), "gemini-embedding-001");
  });
  // 반대 방향: HF 저장소 id 를 남겨둔 채 gemini 로 되돌린 경우
  withEnv({ EMBED_MODEL: "BAAI/bge-m3" }, () => {
    assert.match(embedModelName("gemini"), /^gemini-/);
    assert.equal(embedModelName("local"), "BAAI/bge-m3");
  });
});

test("usesTaskType: gemini 만 비대칭 taskType 을 쓴다(bge-m3 는 프리픽스 불필요)", () => {
  assert.equal(usesTaskType("gemini"), true);
  assert.equal(usesTaskType("local"), false);
});

test("teiEmbedRequest: 배열 입력 + normalize·truncate 활성", () => {
  assert.deepEqual(teiEmbedRequest(["가", "나"]), { inputs: ["가", "나"], normalize: true, truncate: true });
});

test("parseTeiEmbedResponse: 정상 응답을 그대로 통과시킨다", () => {
  const body = [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ];
  assert.deepEqual(parseTeiEmbedResponse(body, 2, 3), body);
});

test("parseTeiEmbedResponse: 개수·차원·형식이 어긋나면 던진다(잘못된 벡터로 색인 오염 방지)", () => {
  assert.throws(() => parseTeiEmbedResponse({ data: [] }, 1, 3), /배열이 아닙니다/);
  assert.throws(() => parseTeiEmbedResponse([[0.1, 0.2, 0.3]], 2, 3), /개수 불일치/);
  assert.throws(() => parseTeiEmbedResponse([[0.1, 0.2]], 1, 3), /차원 불일치/);
  assert.throws(() => parseTeiEmbedResponse([[]], 1, 3), /형식 오류/);
  assert.throws(() => parseTeiEmbedResponse(["nope"], 1, 3), /형식 오류/);
});
