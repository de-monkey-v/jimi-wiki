# Gemini Ingest 에이전트 + 하이브리드 검색 구현 스펙

> 대상: `jimi-wiki-app` (Next.js 16 / React 19 / Prisma 7 + pg adapter / Postgres + pgvector)
> 통합 4개 리서치(function calling / embeddings / hybrid SQL / codebase 정찰)를 모순 없이 단일화한 구현 스펙.
> 모든 경로는 절대경로. 신규 파일 3개 + `wiki.ts` 훅 + UI/actions 변경.

---

## 0. 확정된 전제 (모순 해소)

리서치 간 불일치를 아래로 확정한다.

1. **SDK 버전**: 리서치1은 `@google/genai@2.0.1`을 언급하나 **실제 `package.json`에 설치된 버전은 `^2.10.0`**. 2.10.0 기준으로 작성한다(2.x API 표면은 동일: `ai.models.generateContent` / `ai.models.embedContent`).
2. **API 표면**: 안정성 확보를 위해 `ai.models.generateContent` + **수동 tool 루프** + `ai.models.embedContent`만 사용한다. `ai.interactions.create` / `gemini-3-flash-preview`는 preview이므로 **채택하지 않는다**.
3. **모델명**: 생성 = `gemini-2.5-flash`, 임베딩 = `gemini-embedding-001` (768차원).
4. **임베딩 정규화**: 768차원은 자동 정규화 안 됨 → **수동 L2 정규화 필수**. 코사인 = 내적.
5. **taskType 비대칭**: 인덱싱 = `RETRIEVAL_DOCUMENT`, 쿼리 = `RETRIEVAL_QUERY`.
6. **인덱스는 이미 존재**: `prisma/migrations/20260702051732_init/migration.sql:293,295`에
   `SearchChunk_embedding_hnsw_idx (hnsw vector_cosine_ops)` 와
   `SearchChunk_text_fts_idx (gin to_tsvector('simple', text))` 가 이미 생성돼 있다.
   → **신규 마이그레이션 불필요.** SQL은 반드시 인덱스 표현식과 일치시킨다(`to_tsvector('simple', text)`, `embedding <=> $vec`).
7. **pgvector write/read**: `SearchChunk.embedding`은 `Unsupported("vector(768)")` → Prisma 정규 API 불가. `$executeRawUnsafe` / `$queryRawUnsafe` + `::vector` 캐스트 + 리터럴 문자열 바인딩만 사용.
8. **RRF 상수**: `K=60`, 각 랭커 pool `TOP_N=50`, 최종 `RESULT_N=20`(검색 API 기본, 파라미터로 조정 가능).

환경변수: `GEMINI_API_KEY`. 없으면 임베딩/툴루프 생략, FTS 단독 폴백(아래 각 절 참조).

---

## 1. `src/lib/gemini.ts` — Gemini SDK 래퍼 (server-only)

책임: SDK 초기화 1곳, 임베딩, tool 루프 생성. 다른 모듈은 이 표면만 의존.

```ts
import "server-only";
import {
  GoogleGenAI, FunctionCallingConfigMode, Type,
  type FunctionDeclaration, type Content, type Part, type FunctionCall,
} from "@google/genai";

export const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIM = 768;
export const GEN_MODEL = "gemini-2.5-flash";

/** 키 없으면 null → 호출부에서 FTS 단독 폴백 */
export function geminiEnabled(): boolean;              // !!process.env.GEMINI_API_KEY
function client(): GoogleGenAI;                        // 지연 초기화 싱글턴. 키 없으면 throw

// ---- 임베딩 ----
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
function l2normalize(v: number[]): number[];           // norm===0이면 원본 반환

/**
 * texts를 768차원 L2정규화 벡터로. 요청당 상한 대비 EMBED_BATCH(=100)씩 청크 호출.
 * 키 없으면 throw(호출부에서 geminiEnabled로 사전 분기).
 */
export async function embedTexts(
  texts: string[], taskType: EmbedTaskType,
): Promise<number[][]>;
```

`embedTexts` 내부 정확한 호출 형태:

```ts
const res = await client().models.embedContent({
  model: EMBED_MODEL,
  contents: chunk,                                  // string[] → 입력당 임베딩 1개
  config: { outputDimensionality: EMBED_DIM, taskType },
});
const embs = res.embeddings ?? [];
if (embs.length !== chunk.length) throw new Error(`embed count mismatch ${embs.length}/${chunk.length}`);
out.push(...embs.map(e => {
  if (!e.values) throw new Error("missing embedding values");
  return l2normalize(e.values);                     // ← 768은 수동 L2 필수
}));
```

Tool 루프(생성):

```ts
export interface ToolSpec {
  decl: FunctionDeclaration;                          // name/description/parameters(Type.OBJECT)
  handler: (args: any) => Promise<Record<string, unknown>>;
}
export interface ToolLoopResult { text: string; turns: number; calls: string[]; }

/**
 * 수동 function-calling 루프. functionCalls 없을 때까지 반복(최대 maxTurns).
 * 히스토리 순서 고정: [user] → [model:functionCall] → [user:functionResponse] → …
 */
export async function generateWithTools(opts: {
  system: string;
  userPrompt: string;
  tools: ToolSpec[];
  maxTurns?: number;                                  // 기본 12
}): Promise<ToolLoopResult>;
```

`generateWithTools` 핵심 구현(리서치1 확정 형태):

```ts
const handlers = new Map(opts.tools.map(t => [t.decl.name!, t.handler]));
const contents: Content[] = [{ role: "user", parts: [{ text: opts.userPrompt }] }];
const called: string[] = [];
for (let turn = 0; turn < (opts.maxTurns ?? 12); turn++) {
  const res = await client().models.generateContent({
    model: GEN_MODEL,
    contents,
    config: {
      systemInstruction: opts.system,
      tools: [{ functionDeclarations: opts.tools.map(t => t.decl) }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    },
  });
  const calls: FunctionCall[] | undefined = res.functionCalls;
  if (!calls || calls.length === 0) return { text: res.text ?? "", turns: turn, calls: called };

  const modelContent = res.candidates?.[0]?.content;
  if (modelContent) contents.push(modelContent);      // ← 모델 턴 먼저 push (누락 시 오류)

  const parts: Part[] = [];
  for (const c of calls) {
    called.push(c.name!);
    const h = handlers.get(c.name!);
    let response: Record<string, unknown>;
    try { response = h ? await h(c.args ?? {}) : { error: `unknown function: ${c.name}` }; }
    catch (e) { response = { error: (e as Error).message }; }
    parts.push({ functionResponse: { id: c.id, name: c.name!, response } }); // response는 반드시 객체
  }
  contents.push({ role: "user", parts });             // functionResponse는 user role
}
throw new Error("tool loop exceeded maxTurns");
```

함정 체크: (a) `response`는 객체 필수, (b) 모델 턴 push 후 functionResponse push 순서, (c) 병렬 calls 모두 실행 후 한 번에 push, (d) 다음 major에서 AFC가 chats로 이동해도 이 수동 루프는 무관.

---

## 2. `src/lib/search.ts` — 청킹 / 인덱싱 / 하이브리드 검색 (server-only)

책임: `wikisearch.mjs` 포팅. `Page.body`·`Source.body` → `SearchChunk` 증분 인덱싱 + pgvector/FTS 하이브리드.

```ts
import "server-only";
import { prisma } from "@/lib/db";
import { createHash } from "node:crypto";
import { embedTexts, geminiEnabled, EMBED_DIM } from "@/lib/gemini";

export const MAX_CHUNK = 4000, MIN_CHUNK = 200;
export const RRF_K = 60, POOL = 50, RESULT_N = 20;

export type RefType = "page" | "source";
export interface Chunk { heading: string; text: string; hash: string; }
```

### 2.1 `chunkText`

```ts
/** ref 라벨(예: 페이지 slug/title)을 컨텍스트 프리픽스로. wikisearch.mjs 알고리즘 포팅. */
export function chunkText(label: string, raw: string): Chunk[];
```
알고리즘: (1) frontmatter 제거 `raw.replace(/^---\n[\s\S]*?\n---\n/, "")` (2) `^#{1,6}\s+(.*)` 헤딩 단위 섹션 분할 (3) `text.length > MAX_CHUNK`면 `\n\n+` 문단 단위 재분할 (4) `< MIN_CHUNK` 청크는 직전에 흡수(합계 < MAX_CHUNK 조건) (5) 각 청크 앞에 `[label > heading]\n`(heading 없으면 `[label]\n`) 프리픽스. `hash = sha256(prefixedText).slice(0,16)`.

### 2.2 `indexRef` (내부 upsert) + `reindexPage`

```ts
/**
 * (refType, refId) 청크 전체 재계산 → 증분 upsert.
 * - chunkText로 청크 생성, hash 셋 비교.
 * - 기존 SearchChunk.hash 집합과 완전히 같으면 스킵(no-op) → 임베딩 API도 호출 안 함.
 * - 변경 시: refId 기준 전체 delete → insert (heading/text/hash 저장).
 * - geminiEnabled()면 embedTexts(texts,"RETRIEVAL_DOCUMENT") 후 embedding UPDATE.
 *   키 없으면 embedding NULL로 두고 row만 저장(FTS 단독).
 */
async function indexRef(wikiId: string, refType: RefType, refId: string, label: string, body: string): Promise<{ chunks: number; embedded: boolean }>;

/** wiki.ts 훅용 얇은 래퍼. label = page.slug. */
export async function reindexPage(wikiId: string, page: { id: string; slug: string; body: string }): Promise<void>;
export async function reindexSource(wikiId: string, src: { id: string; slug: string; body: string }): Promise<void>;
```

증분 write 정확한 형태 (pgvector는 raw 필수):

```ts
// 기존 해시
const existing = await prisma.searchChunk.findMany({
  where: { wikiId, refType, refId }, select: { hash: true },
});
const oldSet = new Set(existing.map(r => r.hash));
const newSet = new Set(chunks.map(c => c.hash));
const same = oldSet.size === newSet.size && [...newSet].every(h => oldSet.has(h));
if (same) return { chunks: chunks.length, embedded: false };      // 증분 스킵

await prisma.$transaction(async (tx) => {
  await tx.searchChunk.deleteMany({ where: { wikiId, refType, refId } });
  await tx.searchChunk.createMany({
    data: chunks.map(c => ({ wikiId, refType, refId, heading: c.heading, text: c.text, hash: c.hash })),
  });
});

if (geminiEnabled() && chunks.length) {
  const vecs = await embedTexts(chunks.map(c => c.text), "RETRIEVAL_DOCUMENT");
  // createMany는 id를 안 돌려주므로 hash로 UPDATE (동일 refId 내 hash 유일 가정)
  for (let i = 0; i < chunks.length; i++) {
    const lit = `[${vecs[i].join(",")}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE "SearchChunk" SET embedding = $1::vector WHERE "wikiId"=$2 AND "refType"=$3 AND "refId"=$4 AND hash=$5`,
      lit, wikiId, refType, refId, chunks[i].hash,
    );
  }
}
```

### 2.3 `hybridSearch` — RRF 융합

```ts
export interface SearchHit { id: string; refType: RefType; refId: string; heading: string; text: string; score: number; }

/**
 * FTS(항상) + 벡터(키 있고 임베딩된 청크 존재 시) → RRF 융합.
 * queryText 토큰 없으면 FTS 0건 → 벡터 단독 or 빈결과. 임베딩 없으면 FTS 단독.
 */
export async function hybridSearch(wikiId: string, queryText: string, k = RESULT_N): Promise<SearchHit[]>;
```

**FTS SQL** (인덱스 표현식 `to_tsvector('simple', text)`와 정확히 일치):

```sql
SELECT id
FROM "SearchChunk"
WHERE "wikiId" = $1
  AND to_tsvector('simple', text) @@ websearch_to_tsquery('simple', $2)
ORDER BY ts_rank(to_tsvector('simple', text), websearch_to_tsquery('simple', $2)) DESC
LIMIT $3
```

**벡터 SQL** (`<=>` 코사인, HNSW `vector_cosine_ops`와 일치):

```sql
SELECT id
FROM "SearchChunk"
WHERE "wikiId" = $1
  AND embedding IS NOT NULL
ORDER BY embedding <=> $2::vector ASC
LIMIT $3
```

실행/융합 정확한 형태:

```ts
type IdRow = { id: string };
const ftsRows = await prisma.$queryRawUnsafe<IdRow[]>(FTS_SQL, wikiId, queryText, POOL);

let vecRows: IdRow[] = [];
if (geminiEnabled() && queryText.trim()) {
  const [qv] = await embedTexts([queryText], "RETRIEVAL_QUERY");   // 쿼리는 QUERY taskType
  if (qv?.length === EMBED_DIM) {
    // 위키당 데이터 크면 recall 확보: 세션 GUC
    await prisma.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 100`);
    vecRows = await prisma.$queryRawUnsafe<IdRow[]>(VEC_SQL, wikiId, `[${qv.join(",")}]`, POOL);
  }
}

// RRF: score(id) = Σ 1/(K + rank), rank는 1-based. 스케일 정규화 불필요(rank만 사용).
const scores = new Map<string, number>();
const add = (rows: IdRow[]) => rows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
add(ftsRows); add(vecRows);                            // vecRows=[]면 자동 FTS 단독

const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
// id로 청크 메타 조회(prisma.searchChunk.findMany where id in)해서 SearchHit로 매핑, 순서 보존
```

주의(리서치3): `SET LOCAL`은 트랜잭션 스코프. pg adapter에서 개별 `$executeRawUnsafe`는 세션 재사용 보장이 약하므로, 엄밀히 하려면 `prisma.$transaction`으로 `SET LOCAL` + 벡터쿼리를 묶는다. 한국어 `simple` config 한계(조사/어미 미분리로 recall 낮음)는 알려진 제약 — 벡터 랭커가 이를 보완. 후속 개선은 `pg_bigm`/`pgroonga`.

---

## 3. `src/lib/ingest.ts` — Gemini ingest 에이전트 (server-only)

책임: 원문 수집 → `Source` 저장 → 툴 루프로 페이지 큐레이션 → reindex → `AgentRun`/`LogEntry` 기록.

```ts
import "server-only";
import { prisma } from "@/lib/db";
import { getPage, listPages, createPage, updatePage } from "@/lib/wiki";
import { generateWithTools, geminiEnabled, type ToolSpec } from "@/lib/gemini";
import { reindexSource } from "@/lib/search";
import { Type } from "@google/genai";

export interface IngestInput { url?: string; text?: string; title?: string; }
export interface IngestResult { agentRunId: string; sourceSlug: string; summary: string; pagesTouched: string[]; }

export async function ingestSource(wikiId: string, input: IngestInput, userId?: string): Promise<IngestResult>;
```

### 3.1 흐름

1. **원문 수집**: `url` 있으면 `fetch(url)` → HTML이면 텍스트/마크다운화(MVP: 태그 제거 + 본문 텍스트, 실패 시 원문 저장), `text`면 그대로. `title` 없으면 URL 호스트/첫 줄에서 유도.
2. **Source 저장**: `slug = ${YYYY-MM-DD}-${normalizeSlug(title)}`, `@@unique([wikiId,slug])` 충돌 시 `-2…` 접미. `url` 보존. `reindexSource(wikiId, src)` 호출(원문도 검색 대상).
3. **AgentRun 생성**: `type=ingest, status=running, input=JSON(input)`.
4. **키 없으면 폴백**: `geminiEnabled()===false`면 툴루프 생략 → `Page(kind=note)` 스텁 1개만 생성(제목=title, body=원문 앞부분 + `sources` frontmatter), `status=done`, output에 "LLM 비활성" 명시.
5. **툴 루프**: `generateWithTools({ system: SYSTEM_PROMPT, userPrompt, tools: buildTools(wikiId), maxTurns: 16 })`. userPrompt = 원문 전문(길면 잘라서) + 소스 slug.
6. **종료 후처리**: 툴로 생성/수정된 페이지는 `createPage`/`updatePage`가 이미 `recomputeLinks` + `reindexPage`(§4 훅)를 수행하므로 별도 재계산 불필요. touched 목록만 수집.
7. **기록**: `LogEntry(kind=ingest, title, detail=요약)`, `AgentRun` → `status=done, output=JSON({summary,pagesTouched}), finishedAt`. 예외 시 `status=error, error=msg`.

### 3.2 툴 (전부 wikiId 스코프, handler는 클로저로 wikiId 캡처)

```ts
function buildTools(wikiId: string, touched: Set<string>): ToolSpec[]
```

| 도구 | parameters | handler 동작 |
|---|---|---|
| `listPages` | `{}` | `listPages(wikiId)` → `{ pages: [{slug,title,kind}] }` |
| `readPage` | `{ slug }` | `getPage(wikiId, slug)` → `{ found, title?, kind?, body? }` |
| `writePage` | `{ slug?, title, kind, body }` | slug 있고 존재하면 `updatePage`, 아니면 `createPage`. touched.add(slug). → `{ slug, created:bool }` |
| `searchWiki` | `{ query, k? }` | `hybridSearch(wikiId, query, k ?? 8)` → `{ hits: [{slug/refId, heading, snippet}] }` |
| `appendLog` | `{ title, detail }` | `LogEntry.create(kind:ingest)` (append-only) → `{ ok:true }` |

`kind` enum 검증: `note|concept|entity|answer|meta` 외 값은 handler에서 `note`로 강등. **`Source`는 도구로 노출하지 않는다(불변, 절대 수정 금지 규칙).**

writePage handler는 `Type.OBJECT` 스키마로 선언:
```ts
decl: { name: "writePage", description: "위키 페이지 생성/수정(존재하면 수정)",
  parameters: { type: Type.OBJECT,
    properties: {
      slug: { type: Type.STRING, description: "수정 시 기존 slug. 새 페이지면 생략" },
      title: { type: Type.STRING }, kind: { type: Type.STRING },
      body: { type: Type.STRING, description: "마크다운. 내부링크 [[slug]]" },
    }, required: ["title", "kind", "body"] } }
```

### 3.3 시스템 프롬프트 전문 (한국어, CLAUDE.md 규칙 기반)

```
너는 이 위키의 유지보수자다. 사용자는 소스를 큐레이션하고 질문하며, 요약·상호참조·파일링·일관성 관리는 네 몫이다. 단순 답변으로 끝내지 말고 모든 지식 작업 결과를 위키에 축적하라.

3계층 구조:
(a) 원문(Source): 불변·읽기 전용. 절대 수정·삭제하지 않는다. 도구로 노출되지 않는다.
(b) 위키 페이지(Page): 네가 소유한다. writePage로 생성·갱신·상호참조한다.
(c) 규칙: 이 프롬프트.

Ingest 절차:
1. 주어진 원문을 전부 읽고 핵심(주장·중요 데이터·인용 대목)을 파악한다.
2. searchWiki와 listPages로 기존 위키에 관련 페이지가 있는지 먼저 확인한다.
3. writePage로 kind=note 소스 노트를 만든다: 핵심 주장·데이터·인용. 본문 frontmatter의 sources에 원문 slug를 남긴다.
4. 영향받는 kind=concept / kind=entity 페이지를 갱신하거나 신설한다. 소스 하나가 10~15개 페이지를 건드릴 수 있다 — 링크를 아끼지 말라. 내부 링크는 [[slug]] 또는 [[slug|표시명]].
5. 기존 위키 주장과 모순되면 반드시 플래그한다: "> [!warning] 상충" 콜아웃으로 양쪽 주장과 출처를 남긴다. 기존 내용을 삭제하지 않는다.
6. 각 페이지 하단에 "## 관련 문서" 섹션을 유지한다. 근거 없는 내용은 쓰지 말고, 추측이면 추측이라 명시한다.
7. 작업을 appendLog(title, detail)로 기록한다(append-only, 기존 항목 수정 금지).
8. 마지막 텍스트 응답으로 사용자에게 보고한다: 무엇을 새로 알게 됐고, 어떤 페이지를 만들고 고쳤고, 어떤 모순을 발견했는지.

도구: listPages, readPage, writePage(생성/수정 시 링크·검색 인덱스 자동 재계산), searchWiki(하이브리드), appendLog. 원문(Source)은 절대 변경하지 않는다.
```

### 3.4 안전장치
- 툴 루프 상한 `maxTurns=16` (초과 시 generateWithTools가 throw → AgentRun error).
- handler 인자 방어적 파싱: `args?.slug`, kind enum 화이트리스트, body 문자열 강제.
- `fetch` 타임아웃(AbortController, 예: 15s)·비2xx·과대응답(예: 2MB 초과 절단).
- 모든 handler try/catch로 `{ error }` 반환(루프 중단 대신 모델이 복구).

---

## 4. 인덱싱 훅 — `src/lib/wiki.ts`

`createPage`와 `updatePage`의 `recomputeLinks` 호출 바로 다음에 `reindexPage`를 추가한다. (동기 인라인, MVP 충분. 느리면 후속에 AgentRun 비동기화.)

```ts
// import 추가
import { reindexPage } from "@/lib/search";

// createPage 내부 (recomputeLinks 다음)
await recomputeLinks(wikiId, page.id, page.slug, page.body);
await reindexPage(wikiId, page);            // ← 추가
return page;

// updatePage 내부 (recomputeLinks 다음)
await recomputeLinks(wikiId, page.id, page.slug, page.body);
await reindexPage(wikiId, page);            // ← 추가
return page;
```

주의: `search.ts` → `wiki.ts`(createPage/updatePage를 ingest에서 사용) → `search.ts`(reindexPage) 간 **순환 import**. `reindexPage`는 `wiki.ts`가 값이 아닌 함수로만 참조하고, `ingest.ts`가 `wiki.ts`를 import하므로 런타임 순환은 지연 평가로 해소되나, 안전하게 하려면 `reindexPage`를 `wiki.ts` 상단이 아닌 함수 본문에서 `await import("@/lib/search")`로 동적 import해도 된다(선택). 기본은 정적 import로 시작하고 순환 경고 시 동적 import로 전환.

---

## 5. UI / actions

### 5.1 `src/app/wikis/actions.ts` — 액션 2개 추가

기존 골격(멤버십 게이트) 그대로. import에 `import { ingestSource } from "@/lib/ingest"; import { hybridSearch } from "@/lib/search";` 추가.

```ts
export async function ingestAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  const url = String(formData.get("url") ?? "").trim() || undefined;
  const text = String(formData.get("text") ?? "").trim() || undefined;
  const title = String(formData.get("title") ?? "").trim() || undefined;
  if (!url && !text) throw new Error("URL 또는 텍스트가 필요합니다");
  await ingestSource(wiki.id, { url, text, title }, userId);   // MVP: 인라인 await
  revalidatePath(`/wikis/${wikiSlug}`);                        // raw slug (savePageAction과 동일)
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
}

// 검색은 redirect로 ?q= 전달 → page.tsx가 서버렌더 (별도 결과 라우트 불필요)
export async function searchAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug"));
  const q = String(formData.get("q") ?? "").trim();
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}?q=${encodeURIComponent(q)}`);
}
```

### 5.2 `src/app/wikis/[slug]/page.tsx` — 폼 2개 + 검색결과

- 시그니처를 `searchParams`도 받도록: `{ params, searchParams }: { params: Promise<{slug:string}>; searchParams: Promise<{ q?: string }> }`.
- 한글 슬러그 규칙 유지: 진입 시 `const slug = decodeURIComponent(rawSlug)`, 내부 `<Link>`/hidden input value는 raw `slug`, redirect만 `encodeURIComponent`.
- 게이트 후 `q`가 있으면 `const hits = await hybridSearch(wiki.id, q)` → `<h1>` 아래 결과 섹션 렌더. `refType==="page"`면 `<Link href={/wikis/${slug}/${...}>` (SearchChunk에 slug 없으므로 refId→page 조회 or hit에 slug 포함하도록 hybridSearch가 page slug join). `KIND_LABEL` 뱃지 재사용.
- 검색 박스: `<form action={searchAction}>` + hidden `wikiSlug=slug` + `<input name="q" defaultValue={q}>`.
- Ingest 패널: 기존 "새 페이지" form 옆에 `<form action={ingestAction}>` + hidden `wikiSlug` + `<input name="url">` + `<textarea name="text">` + optional `<input name="title">`. 제출 = "수집" 버튼.

구현 편의: `hybridSearch`가 반환하는 `SearchHit`에 `pageSlug?: string`를 포함하도록(refType='page'일 때 `Page.slug` join) UI 링크가 단순해진다. 권장.

---

## 6. 오류 / 폴백 매트릭스

| 상황 | 동작 |
|---|---|
| `GEMINI_API_KEY` 없음 | 임베딩 생략(embedding NULL) + 검색은 FTS 단독 + ingest는 note 스텁만 |
| 쿼리 토큰 없음(FTS 0건) | 벡터 단독(키 있으면) 또는 빈 결과 |
| 임베딩 count mismatch | throw → indexRef 실패, AgentRun error |
| 툴 루프 maxTurns 초과 | throw → AgentRun status=error |
| handler 예외 | `{ error }` 반환, 루프 계속(모델이 복구) |
| fetch 실패/타임아웃 | 원문 없이 실패 or text 대체, 사용자 오류 표시 |
| pgvector 리터럴 | 항상 `[a,b,...]` 문자열 + `::vector` 캐스트, 정규 Prisma 미사용 |
| JSON 파싱 | `args`는 방어적 접근(`args?.x`), kind는 화이트리스트 |

---

## 7. 검증 계획

전제: `pnpm db:up && pnpm db:seed` 완료, `.env`에 `DATABASE_URL`, (선택)`GEMINI_API_KEY`, `DEV_USER_EMAIL`.

1. **빌드/타입**: `pnpm lint` + `pnpm build` (또는 `npx tsc --noEmit`) — 신규 3파일 + 훅 컴파일 확인.
2. **인덱스 확인**: `psql $DATABASE_URL -c "\d+ \"SearchChunk\""` → `SearchChunk_embedding_hnsw_idx`, `SearchChunk_text_fts_idx` 존재(이미 init 마이그레이션에 있음).
3. **위키 준비**: 앱 실행(`pnpm dev`) → 로그인(dev 스텁) → 위키 1개 생성.
4. **URL ingest**: 위키 홈 ingest 패널에 실제 URL 1개(예: 위키백과 문서) 입력 → 수집.
   - 확인: `Source` 1행 생성(`select slug,url from "Source"`), `Page(kind=note)` 1+개 생성, (키 있으면)`concept/entity` 페이지 추가 생성.
   - 확인: `AgentRun`(type=ingest, status=done, output에 summary), `LogEntry`(kind=ingest).
   - 확인: `SearchChunk` 행 생성, 키 있으면 `embedding IS NOT NULL` 카운트 > 0
     (`select count(*), count(embedding) from "SearchChunk" where "wikiId"=…`).
5. **검색(하이브리드)**: 검색 박스에 ingest한 내용의 키워드 쿼리 → `?q=` 결과에 관련 페이지가 상위 노출.
   - 키 있음: FTS+벡터 RRF 융합 결과.
   - 키 제거 후 재기동: FTS 단독으로도 결과 반환(폴백 동작) 확인.
6. **증분 스킵**: 동일 페이지를 내용 변경 없이 재저장 → `indexRef`가 hash 동일로 no-op(임베딩 API 미호출) 로그/카운트로 확인.
7. **링크/모순**: ingest가 만든 페이지에 `[[slug]]` 링크 렌더 확인, 모순 케이스면 `> [!warning] 상충` 콜아웃 존재 확인.
8. **격리**: 다른 위키에서 동일 쿼리 → 0건(‑ `wikiId` 스코프 검증).

---

## 8. 신규/변경 파일 요약

| 파일 | 상태 | 핵심 export |
|---|---|---|
| `/home/gyu/dev/active/jimi-wiki-app/src/lib/gemini.ts` | 신규 | `embedTexts`, `generateWithTools`, `geminiEnabled`, 상수 |
| `/home/gyu/dev/active/jimi-wiki-app/src/lib/search.ts` | 신규 | `chunkText`, `reindexPage`, `reindexSource`, `hybridSearch` |
| `/home/gyu/dev/active/jimi-wiki-app/src/lib/ingest.ts` | 신규 | `ingestSource`, 시스템 프롬프트, wiki 스코프 툴 |
| `/home/gyu/dev/active/jimi-wiki-app/src/lib/wiki.ts` | 변경 | createPage/updatePage에 `reindexPage` 훅 |
| `/home/gyu/dev/active/jimi-wiki-app/src/app/wikis/actions.ts` | 변경 | `ingestAction`, `searchAction` |
| `/home/gyu/dev/active/jimi-wiki-app/src/app/wikis/[slug]/page.tsx` | 변경 | ingest 폼 + 검색 박스 + `?q=` 결과 |
| 마이그레이션 | 불필요 | HNSW/GIN 인덱스 init에 이미 존재 |
```
