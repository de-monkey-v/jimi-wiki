# 콘텐츠 코어 + 선택적 임베딩 + 인증 콘텐츠 API + 비동기 ingest 잡 — 통합 구현 스펙

> 대상 리포: `jimi-wiki-app` (Next.js 16 App Router, Prisma, pgvector, `@google/genai`)
> 이 문서는 리서치1(Next16 백그라운드 잡)·리서치2(API 키 인증)·리서치3(콘텐츠 코어 디커플링)을 모순 없이 통합한 단일 실행 스펙이다.
> 코드 인용은 실제 파일 기준(작성 시점 라인). **핵심 불변식: 저장 훅은 항상 FTS-only, 임베딩은 `reindexEmbeddings` 단일 경로.**

---

## 0. 현재 상태 스냅샷 (검증 완료)

이미 존재하는 것 (리서치2가 선행 구현):
- `prisma/schema.prisma`: `ApiKey` 모델(L77-88), `User.apiKeys` 백릴레이션(L71) **정의됨**. 단, 기존 마이그레이션(`20260702051732_init`)에는 **미포함** → 신규 마이그레이션 필요.
- `src/lib/apikey.ts`: `generateApiKey`/`hashApiKey`/`createApiKey`/`getApiUser` **구현 완료**. 변경 불필요.
- `src/app/api/wikis/[slug]/route.ts`: `getApiUser → getWikiForUser` 게이트 **예시 라우트 존재**. 콘텐츠 API의 패턴 템플릿으로 재사용.

아직 없는 것 (이 스펙이 추가):
- 임베딩 디커플링(search.ts 리팩터).
- 콘텐츠 API 6종 라우트.
- 비동기 ingest 분할(`createIngestRun`/`runIngestJob`).
- 키 발급 경로(스크립트/라우트).
- UI ingest 폼 비동기화.

스키마 사실 (그라운딩):
- `SearchChunk.embedding`: `Unsupported("vector(768)")?` — nullable. backfill 모델을 그대로 수용(스키마 무변경).
- `AgentRun`: `status AgentStatus @default(pending)`, enum = `pending|running|done|error`; `type AgentType` = `ingest|query|lint`; `input Json @default("{}")`, `output Json?`, `error String?`, `finishedAt DateTime?`, `@@index([wikiId, createdAt])`.
- `embedTexts(texts, taskType)`(gemini.ts L83): 내부 `batchByBudget`로 요청당 상한 처리, **입력 순서 보존 반환**. `EMBED_DIM=768`, `geminiEnabled()`.

---

## 1. (A) 임베딩 디커플링 — `search.ts` 리팩터 (Option B)

**결정: Option B(저장 훅에서 임베딩 제거 + 명시 호출).** `createPage/updatePage/upsertPage`에 `embed` 플래그를 스레딩하지 않는다. 변경 범위를 `search.ts` 내부로 국한하고 `wiki.ts`는 한 줄도 고치지 않는다(`reindexPage`/`reindexSource` 시그니처 불변, 동작만 "FTS 전용"으로 축소).

근거: Option A는 `createPage → updatePage → upsertPage → reindexPage → indexRef → embedChunks` 6개 시그니처와 모든 호출부(actions.ts, ingest.ts writePage)를 오염시킨다. Option B는 저장 경로를 단일 규칙(FTS-only)으로 유지한다.

### 1.1 `indexRef` → `indexChunksOnly` (임베딩 로직 제거)

현재 `indexRef`(search.ts L101-142)는 `isnull` 조회(L111-112), backfill 분기(L122-129), 두 개의 `embedChunks` 호출(L125, L140)로 **키가 있으면 인라인 임베딩**을 수행한다. 이 결합이 "AI 없이 올리기"를 막는 유일한 지점.

신규 시그니처(반환에서 `embedded` 제거, `chunks`만):
```ts
// reindexPage/reindexSource가 부르는 저장 훅. FTS 청크만 항상 갱신. 임베딩 없음.
async function indexChunksOnly(
  wikiId: string, refType: RefType, refId: string, label: string, body: string,
): Promise<{ chunks: number }>
```
동작:
1. `chunkText(label, body)`로 청크 계산.
2. `SELECT hash FROM "SearchChunk" WHERE wikiId/refType/refId` (기존 `isnull` 컬럼 조회 제거).
3. hash 집합이 동일하고 `chunks.length > 0`이면 조기 반환 → **기존 임베딩 보존**(재저장 시 벡터 유실 방지).
4. 변경 시 트랜잭션으로 `deleteMany` + `createMany`(embedding 컬럼은 자동 NULL).
5. `return { chunks: chunks.length }` — 새 청크는 embedding NULL 상태로 남아 `reindexEmbeddings`가 backfill.

`reindexPage`(L144)·`reindexSource`(L147)는 본문의 `indexRef` 호출만 `indexChunksOnly`로 교체. **반환 타입이 `{chunks}`로 좁혀지지만, 호출부(wiki.ts L86/L100/L124, ingest.ts L211)는 반환값을 사용하지 않으므로 무영향.**

### 1.2 `embedChunks`(L76-99) 삭제
hash 기준 UPDATE(L86)는 dead code가 된다. id 기준 backfill(`reindexEmbeddings`)이 대체.

### 1.3 `reindexEmbeddings(wikiId)` 신규 (NULL backfill 단일 경로)
```ts
/** embedding IS NULL 청크를 backfill. /reindex 라우트·ingest 후처리용. 비치명적. */
export async function reindexEmbeddings(wikiId: string): Promise<{ embedded: number }>
```
동작:
1. `if (!geminiEnabled()) return { embedded: 0 }`.
2. `SELECT id, text FROM "SearchChunk" WHERE wikiId=$1 AND embedding IS NULL`.
3. 비어 있으면 `{ embedded: 0 }`.
4. `embedTexts(rows.map(r=>r.text), "RETRIEVAL_DOCUMENT")` — 내부 배치 분할, 순서 보존.
5. 각 행: `UPDATE "SearchChunk" SET embedding = $1::vector WHERE id = $2` (`[v.join(",")]`, `rows[i].id`). **id 기준이라 hash 충돌 무관**, `vecs[i] ↔ rows[i]` 정렬 성립.
6. `return { embedded: rows.length }`.

호출부는 실패를 삼켜 비치명적 처리(`.catch`).

### 1.4 트레이드오프(명시)
Option B에서 수동 저장 직후 벡터는 즉시 갱신되지 않고 다음 `reindexEmbeddings`까지 stale하다. 이것이 "AI 없이 올리기"의 의도된 대가이며 `/reindex` 라우트와 ingest 후처리가 메운다.

### 1.5 변경 파일
| 파일 | 변경 |
|---|---|
| `src/lib/search.ts` | `indexRef`→`indexChunksOnly`(임베딩 제거), `embedChunks` 삭제, `reindexEmbeddings` export 추가. `reindexPage`/`reindexSource` 본문 1줄 교체 |
| `src/lib/wiki.ts` | **무변경** |

---

## 2. (B) API 키 인증 — 마무리 (대부분 완료)

### 2.1 마이그레이션 (해야 할 일)
`ApiKey` 모델은 schema에 있으나 마이그레이션 미생성. 실행:
```bash
pnpm db:migrate   # = prisma migrate dev — ApiKey 테이블 + unique(hashedKey) + index(userId) 생성
```
`@@index([userId])`, `hashedKey @unique`는 스키마에 이미 선언됨 → **수동 인덱스 추가 불필요**.

### 2.2 `src/lib/apikey.ts` — 변경 없음 (검증됨)
- `generateApiKey()`: `randomBytes(32).base64url` → `jw_<secret>`, `prefix`=앞 12자, `hashedKey`=sha256 hex. 원문 미저장.
- `getApiUser(req: Request): Promise<User|null>`: `Authorization: Bearer`(스킴 대소문자 무시) 파싱 → sha256 → `findUnique({where:{hashedKey}, include:{user}})` → 동일 길이 hex `timingSafeEqual`(길이 가드) → fire-and-forget `lastUsedAt` → `User|null`. `Request` 타입이라 `NextRequest` 그대로 통과.
- 설계 근거(defense-in-depth): 조회는 unique `hashedKey` 인덱스 O(1), `timingSafeEqual`은 반환 행 해시의 상수 시간 재확인. `hashedKey`는 256비트 시크릿의 해시라 WHERE 노출 안전.

### 2.3 키 발급 경로 (신규 — 최소)
브라우저 세션은 `getCurrentUserId()`(session.ts, 현재 DEV 스텁)로 인증되므로, 발급은 세션 게이트로 충분.

**택1 (권장, 스크립트): `prisma/` 또는 `scripts/`에 발급 CLI**
```ts
// scripts/issue-api-key.ts  —  tsx scripts/issue-api-key.ts "<name>"
// getCurrentUserId() 또는 DEV_USER_EMAIL 유저 조회 → createApiKey(userId, name) → token을 stdout에 1회 출력
```
`package.json`에 `"apikey:issue": "tsx scripts/issue-api-key.ts"` 추가.

**택2 (선택, 라우트): `POST /api/keys`**
```ts
// src/app/api/keys/route.ts
// getCurrentUserId() (세션) → createApiKey(userId, name) → 201 { id, name, prefix, token } (token 1회)
// GET /api/keys → 발급 목록(prefix, name, lastUsedAt만; token/hashedKey 미노출)
```
주의: 이 라우트는 **세션 인증**(브라우저)이지 Bearer 인증이 아니다. Bearer로 자기 자신을 부트스트랩할 수 없으므로 최초 키는 스크립트/세션으로 발급.

---

## 3. (C) 콘텐츠 API 라우트 6종

### 3.1 공통 규약
- 위치: `src/app/api/wikis/[id]/...` — **`:id`는 wiki slug로 통일**(기존 `getWikiForUser(userId, slug)`가 slug 기반, L43). 라우트 파일명이 `[id]`여도 값은 slug.
  - 대안(비권장): cuid로 키잉하려면 wiki.ts에 6줄 `getWikiByIdForUser`(findUnique `where:{id}` + 멤버십) 추가. 이 스펙은 **slug 통일 채택**.
- 게이트(전 라우트 동일):
  ```ts
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  const { id } = await params;                       // Next16: params는 Promise
  const wiki = await getWikiForUser(user.id, id);    // id = slug
  if (!wiki) return NextResponse.json({ error: "not_found" }, { status: 404 });
  ```
  이는 `src/app/api/wikis/[slug]/route.ts`의 검증된 패턴과 동일.
- slug 디코딩: Next가 경로 파라미터를 이미 디코드 → 별도 `decodeURIComponent` 불필요. 응답에 slug를 URL로 넣을 때만 `encodeURIComponent`(page.tsx L14/L25 규칙 유지).
- 모든 응답 `Cache-Control: no-store`(동적, 인증). 라우트에 `export const dynamic = "force-dynamic"`.

### 3.2 라우트 매핑
| 라우트 | 메서드 | 재사용 함수 | 반환 |
|---|---|---|---|
| `/api/wikis/[id]/pages` | GET | `listPages(wiki.id)` (wiki.ts L52) | `{ pages: [...] }` |
| `/api/wikis/[id]/pages` | POST | `upsertPage(wiki.id, {slug?,title,kind,body})` (L108) | `{ slug, created }` (+embed 시 `{embedded}`) |
| `/api/wikis/[id]/ingest` | POST | `createIngestRun` + `after(runIngestJob)` (§4) | 202 `{ runId, status:"pending" }` |
| `/api/wikis/[id]/runs/[runId]` | GET | `prisma.agentRun.findUnique` | `{ runId, status, output?, error? }` |
| `/api/wikis/[id]/reindex` | POST | `reindexEmbeddings(wiki.id)` (§1.3) | `{ embedded }` |
| `/api/wikis/[id]/search` | GET | `hybridSearch(wiki.id, q, k)` (search.ts L178) | `{ hits: [...] }` |

### 3.3 상세

**`GET /api/wikis/[id]/pages`** — 게이트 후 `listPages(wiki.id)` 그대로 JSON.

**`POST /api/wikis/[id]/pages`** (raw 업로드 + 선택적 임베딩):
```ts
// body: { slug?: string, title: string, kind: PageKind, body: string, embed?: boolean }
const { slug, title, kind, body, embed } = await req.json();
const res = await upsertPage(wiki.id, { slug, title, kind, body });   // 코어 = FTS-only
let embedded = 0;
if (embed) ({ embedded } = await reindexEmbeddings(wiki.id));         // 라우트 레벨에서만 임베딩
return NextResponse.json({ ...res, embedded }, { status: res.created ? 201 : 200 });
```
`kind`는 `PageKind` 화이트리스트(`note|concept|entity|answer|meta`) 검증(ingest.ts `coerceKind` 재사용 가능). `title`/`body` 누락 시 400. **코어는 항상 FTS-only, 임베딩은 라우트가 `reindexEmbeddings`로만** → 단일 규칙 유지.

**`POST /api/wikis/[id]/ingest`** (비동기, §4):
```ts
const input: IngestInput = await req.json();   // { url?, text?, title? }
if (!input.url && !input.text) return NextResponse.json({ error: "url_or_text_required" }, { status: 400 });
const run = await createIngestRun(wiki.id, input, user.id);
after(() => runIngestJob({ id: run.id, wikiId: wiki.id, input, userId: user.id }));
return NextResponse.json({ runId: run.id, status: "pending" }, { status: 202 });
```
`export const maxDuration = 60`(서버리스 대비; self-host Node는 무제한), `export const dynamic = "force-dynamic"`.

**`GET /api/wikis/[id]/runs/[runId]`** (폴링):
```ts
// 게이트로 wiki 접근 확인 후
const run = await prisma.agentRun.findUnique({ where: { id: runId } });
if (!run || run.wikiId !== wiki.id) return NextResponse.json({ error: "not_found" }, { status: 404 });  // 테넌트 격리
return NextResponse.json(
  { runId: run.id, status: run.status,                       // pending|running|done|error
    output: run.status === "done" ? run.output : undefined,   // { summary, pagesTouched }
    error: run.status === "error" ? run.error : undefined },
  { status: 200, headers: { "Cache-Control": "no-store" } });
```
`params: Promise<{ id: string; runId: string }>`. **`run.wikiId !== wiki.id` 검사로 타 위키 run 조회 차단.**

**`POST /api/wikis/[id]/reindex`** — 게이트 후 `reindexEmbeddings(wiki.id)` → `{ embedded }`. gemini 미설정이면 `{ embedded: 0 }`.

**`GET /api/wikis/[id]/search?q=&k=`** — `q` 필수(없으면 `{ hits: [] }`), `k`는 정수 파싱(기본 `RESULT_N`=20, 상한 클램프 권장). `hybridSearch(wiki.id, q, k)` → `{ hits }`.

### 3.4 신규 파일
```
src/app/api/wikis/[id]/pages/route.ts             (GET, POST)
src/app/api/wikis/[id]/ingest/route.ts            (POST)
src/app/api/wikis/[id]/runs/[runId]/route.ts      (GET)
src/app/api/wikis/[id]/reindex/route.ts           (POST)
src/app/api/wikis/[id]/search/route.ts            (GET)
```
기존 `src/app/api/wikis/[slug]/route.ts`(예시)는 `[id]`와 세그먼트명이 달라 **충돌**한다(Next는 동일 레벨 동적 세그먼트 이름 불일치 시 빌드 에러). → 기존 파일을 `src/app/api/wikis/[id]/route.ts`로 **리네임**(GET 위키 메타)하고 내부 `slug` 파라미터명을 `id`로 통일. 이로써 모든 콘텐츠 API가 `[id]` 하위로 정렬.

---

## 4. (D) 비동기 ingest — `ingest.ts` 분할 + 백그라운드 스케줄

### 4.1 스케줄 방식 결정: **`after()`** (리서치1 (2)패턴)
- self-host Node(`next start`): 응답 후 ~50s 작업이 끝까지 실행됨(공식 지원). SIGTERM 시 10~30s drain으로 대기 콜백 완료.
- 상태는 DB(`AgentRun`)에 영속화 → `/runs/[runId]` 폴링이 진행 상황을 본다.
- 한계 감수: 크래시/재배포 유실, 재시도 없음. **보완책(선택): `pending`/`running` 정체 레코드를 실패 처리하는 리퍼 크론.** 프로덕션 승격 경로는 §4.4.

### 4.2 `ingest.ts` 분할 (기존 `ingestSource` L191-257 최소 이관)
현재 `ingestSource`는 내부에서 `AgentRun`을 `status:"running"`으로 생성(L203-205)하고 완료 후에야 `agentRunId`를 반환한다. 비동기 응답에는 **시작 시점 runId**가 필요하므로 분할:

```ts
// (1) pending 레코드만 즉시 생성 — 폴링이 곧바로 볼 수 있게 커밋
export async function createIngestRun(
  wikiId: string, input: IngestInput, userId?: string
): Promise<{ id: string }> {
  return prisma.agentRun.create({
    data: { wikiId, userId: userId ?? null, type: "ingest", status: "pending", input: input as object },
    select: { id: true },
  });
}

// (2) 실제 처리 — 기존 L207-256 본문을 거의 그대로 이관. run은 인자로 받고 running→done/error 전이.
export async function runIngestJob(run: {
  id: string; wikiId: string; input: IngestInput; userId: string | null;
}): Promise<void> {
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: "running" } });
  try {
    // 기존 L192-243 흐름: 원문 수집 → title 유도 → createSourceUnique → reindexSource(FTS-only)
    //   → geminiEnabled? 툴 루프 : 폴백 스텁 → logEntry 기록
    // ▼ 신규: 루프 종료 후 위키 단위 1회 임베딩 backfill (비치명적) — §5
    if (geminiEnabled()) {
      await reindexEmbeddings(run.wikiId).catch((e) =>
        console.error(`[ingest] 임베딩 backfill 실패(다음 /reindex에서 복구): ${(e as Error).message}`));
    }
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "done", output: { summary, pagesTouched: [...touched] }, finishedAt: new Date() },
    });
  } catch (e) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "error", error: (e as Error).message, finishedAt: new Date() },
    });
  }
}

// (3) 동기 편의(CLI/테스트) — 기존 시그니처 유지, 하위호환
export async function ingestSource(
  wikiId: string, input: IngestInput, userId?: string
): Promise<IngestResult> {
  const run = await createIngestRun(wikiId, input, userId);
  await runIngestJob({ id: run.id, wikiId, input, userId: userId ?? null });
  const done = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  // 기존 IngestResult 형태로 매핑(sourceSlug/summary/pagesTouched는 output에서 복원 또는 runIngestJob이 반환하도록)
  return /* { agentRunId: run.id, ...output } */;
}
```
주의: 기존 `ingestSource`는 예외를 `throw`했다(L255). `ingestAction`(actions.ts L51)이 이를 await하므로 동기 경로는 **throw 유지**, 비동기 경로(`runIngestJob`)는 **throw 대신 error 상태로 삼킴**(응답 후 실행이라 던질 곳이 없음).

import 추가: `ingest.ts` 상단 `import { hybridSearch, reindexSource, reindexEmbeddings } from "@/lib/search";`, 라우트에서 `import { after } from "next/server";`.

### 4.3 운영 주의 (리서치1 근거)
- self-host Docker/PM2/k8s: SIGTERM 후 **10~30s drain** 부여(k8s `terminationGracePeriodSeconds`, Docker `--stop-timeout`). 없으면 진행 중 `after` 콜백 절단.
- Static export 미지원(해당 없음 — 이 앱은 동적 서버).

### 4.4 프로덕션 승격 (선택, 코드 변경 최소)
`after(() => runIngestJob(...))`를 `await queue.add("ingest", { runId })`로 바꾸고 외부 워커가 동일한 `createIngestRun`→`runIngestJob` 전이를 수행. 재시도·재배포 안전·수평확장. `AgentRun` 상태 머신은 그대로 재사용.

---

## 5. 내부 에이전트(writePage) 임베딩 — 종료 후 1회 backfill

writePage 툴(ingest.ts L88)은 `upsertPage`→이제 FTS-only, `reindexSource`(L211)도 FTS-only. 따라서 개별 writePage마다 임베딩하지 않고 **에이전트 루프 종료 후 위키 단위 1회** `reindexEmbeddings(wikiId)`로 소스 청크 + touched 페이지 청크를 한 번의 배치 임베딩으로 채운다(효율적). 삽입 위치는 §4.2 `runIngestJob`의 done 기록 직전. gemini 미설정이면 no-op.

---

## 6. (E) UI — `[slug]/page.tsx` ingest 폼 비동기화 + raw 경로 노출

### 6.1 Ingest 폼 → 잡 시작 + 상태 표시 (권장: 클라이언트 `IngestPanel` + 폴링)
현재 `ingestAction`(actions.ts L42-54)은 `await ingestSource`로 완료까지 블로킹 후 redirect. 최소 변경:
- page.tsx L108-116 ingest 폼만 **클라이언트 컴포넌트** `src/app/wikis/[slug]/IngestPanel.tsx`로 분리. 나머지 서버 컴포넌트 구조·slug 규칙(L23-24 decode, L69/L96 링크) 유지.
- `IngestPanel(props: { slug: string })`:
  1. `POST /api/wikis/${encodeURIComponent(slug)}/ingest` (body: `{url,text,title}`) → `{ runId }`.
     - 주의: 이 fetch는 **동일 오리진 브라우저 세션**이 아니라 Bearer 인증 라우트다. UI에서 부르려면 (a) 세션 쿠키도 받는 별도 게이트를 라우트에 추가하거나, (b) UI는 기존 서버 액션 경로(§6.2)를 쓰고 Bearer 라우트는 외부 전용으로 둔다. **권장: (b)** — UI/외부 관심사 분리. 아래 §6.2 채택 시 IngestPanel은 서버 액션 호출 + `?run=` 폴링.
  2. `GET .../runs/${runId}`를 2~3s 간격 폴링, `status`가 `done`/`error`면 중단. `output.summary` 인라인 표시. `done`이면 `router.refresh()`로 페이지 목록 갱신.

### 6.2 대안(신규 컴포넌트 0개, 서버 액션 유지) — **UI에 채택 권장**
`ingestAction`을 비동기로:
```ts
export async function ingestAction(formData: FormData) {
  // ... 기존 게이트(userId, getWikiForUser) 유지 ...
  const run = await createIngestRun(wiki.id, { url, text, title }, userId);
  after(() => runIngestJob({ id: run.id, wikiId: wiki.id, input: { url, text, title }, userId }));
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}?run=${run.id}`);
}
```
서버 컴포넌트(page.tsx)가 `searchParams.run`을 읽어 `prisma.agentRun.findUnique`로 현재 상태 배지 렌더(폴링 없이 새로고침으로 확인). 실시간성은 낮지만 신규 컴포넌트 0개. **서버 액션에서도 `after`를 쓸 수 있음**(리서치1: Server Actions 지원).
- 이 경우 `actions.ts`는 `import { after } from "next/server"`, `import { createIngestRun, runIngestJob } from "@/lib/ingest"`로 교체(기존 `ingestSource` import 제거 가능하나 하위호환 위해 유지 무방).

**결정: UI는 §6.2(서버 액션 + `?run=` 배지), 실시간 폴링이 필요하면 §6.1의 `/runs` 라우트가 이미 있으니 IngestPanel로 승격.** 두 경로 모두 동일한 `createIngestRun`/`runIngestJob`/`AgentRun` 상태를 공유해 모순 없음.

### 6.3 "그냥 올리기(raw)" 경로 UI 노출
현재 "새 페이지(수동)" 폼(L119-131)은 `createPageAction`→`createPage`(빈 body)→edit로 이동. 이는 이미 코어(FTS-only)를 타므로 **AI 없이 올리기**가 기본 동작이 되었다(자동 임베딩 제거의 직접 효과). 추가 노출:
- edit 저장(`savePageAction`, L28-40 → `updatePage`)도 FTS-only. 즉 **모든 수동 저장은 임베딩 없이 즉시 완료**.
- 위키 홈에 "시맨틱 재색인" 버튼(선택): `POST /api/wikis/[id]/reindex` 또는 서버 액션 `reindexAction`→`reindexEmbeddings(wiki.id)` → `{embedded}` 토스트. 수동 raw 업로드 후 사용자가 명시적으로 임베딩을 채우는 UX.

---

## 7. 하위호환 / 마이그레이션 주의

1. **자동 임베딩 제거의 영향**: 기존 페이지의 임베딩은 **유지**(indexChunksOnly가 hash 동일 시 조기 반환해 벡터 보존). 그러나 **신규 저장/수정은 FTS-only** → 해당 청크는 임베딩 NULL로 남아 최초 시맨틱 recall이 낮아진다. `hybridSearch`는 FTS 단독으로 graceful degrade(search.ts L184-195, VEC_SQL은 `embedding IS NOT NULL`만 조회)하므로 **검색은 죽지 않음**, 벡터 커버리지만 지연. `/reindex`(수동) 또는 ingest 후처리(자동)가 보완.
2. **ApiKey 마이그레이션**: `pnpm db:migrate` 필수(테이블 미생성 상태). 스키마 선언된 unique/index로 수동 DDL 불필요.
3. **라우트 리네임**: 기존 `api/wikis/[slug]/route.ts` → `[id]/route.ts`(세그먼트명 충돌 회피). 외부 호출자가 있으면 경로 자체는 `/api/wikis/<slug>`로 불변(파일명만 변경).
4. **`ingestSource` 반환 형태**: 분할 후에도 `IngestResult` 유지. CLI/테스트 호출부 무변경.
5. **schema 무변경 대상**: `gemini.ts`/`db.ts`/`session.ts`/`schema.prisma`(SearchChunk/AgentRun 부분) 손대지 않음.

---

## 8. 변경 파일 요약

| 파일 | 상태 | 변경 |
|---|---|---|
| `prisma/schema.prisma` | 기존 | 무변경(ApiKey 이미 선언). **`pnpm db:migrate`로 테이블 생성** |
| `src/lib/apikey.ts` | 기존 | 무변경 |
| `src/lib/search.ts` | 변경 | `indexChunksOnly`(FTS-only), `embedChunks` 삭제, `reindexEmbeddings` 추가 |
| `src/lib/wiki.ts` | 기존 | **무변경** |
| `src/lib/ingest.ts` | 변경 | `createIngestRun`/`runIngestJob` 분할, 루프 후 `reindexEmbeddings` 1회, import 추가 |
| `src/app/api/wikis/[id]/route.ts` | 리네임 | 기존 `[slug]/route.ts`에서 이동, 파라미터 `slug→id` |
| `src/app/api/wikis/[id]/pages/route.ts` | 신규 | GET/POST(embed 플래그) |
| `src/app/api/wikis/[id]/ingest/route.ts` | 신규 | POST(202 + runId, `after`) |
| `src/app/api/wikis/[id]/runs/[runId]/route.ts` | 신규 | GET(폴링, 테넌트 가드) |
| `src/app/api/wikis/[id]/reindex/route.ts` | 신규 | POST |
| `src/app/api/wikis/[id]/search/route.ts` | 신규 | GET |
| `src/app/api/keys/route.ts` (또는 `scripts/issue-api-key.ts`) | 신규 | 키 발급(세션 게이트) |
| `src/app/wikis/actions.ts` | 변경 | `ingestAction` 비동기화(`createIngestRun`+`after`+`?run=`) |
| `src/app/wikis/[slug]/page.tsx` (+`IngestPanel.tsx` 선택) | 변경 | ingest 상태 배지/폴링, reindex 버튼(선택) |

---

## 9. 검증 계획 (수용 기준)

전제: `pnpm db:migrate` 완료, dev 서버 기동, `TOKEN`=발급 키.

1. **API 키 발급**: `tsx scripts/issue-api-key.ts "ci"` (또는 `POST /api/keys`) → `jw_...` 토큰 1회 출력. DB엔 hashedKey/prefix만.
2. **raw 페이지 업로드(임베딩 X)**:
   ```bash
   curl -X POST localhost:3000/api/wikis/<slug>/pages \
     -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"title":"Raw Doc","kind":"note","body":"# T\n임베딩 없이 저장 테스트","embed":false}'
   ```
   → `{ slug, created:true, embedded:0 }`. DB: 해당 청크 `embedding IS NULL` 확인.
3. **FTS-only 검색 확인**: `GET /api/wikis/<slug>/search?q=임베딩` → 방금 문서가 FTS로 히트(벡터 NULL이어도). `SELECT count(*) FROM "SearchChunk" WHERE embedding IS NULL` > 0.
4. **/reindex 후 시맨틱 검색**: `curl -X POST .../reindex -H "authorization: Bearer $TOKEN"` → `{ embedded: N>0 }`. 이후 `embedding IS NULL` 카운트 감소, 시맨틱 유사 쿼리(정확 단어 불일치)가 히트하는지 확인.
5. **인증 실패 경로**: 토큰 없이 호출 → 401 `WWW-Authenticate: Bearer`. 타 위키 slug → 404. 남의 위키 `runId` 조회 → 404(테넌트 가드).
6. **비동기 ingest jobId 폴링**:
   ```bash
   RID=$(curl -s -X POST .../ingest -H "authorization: Bearer $TOKEN" \
     -H "content-type: application/json" -d '{"text":"...원문...","title":"S1"}' | jq -r .runId)
   # 즉시 202 + runId. 반복:
   curl -s .../runs/$RID -H "authorization: Bearer $TOKEN"
   ```
   → `pending → running → done` 전이, `done`이면 `output.summary`/`pagesTouched`. gemini 설정 시 done 후 소스/페이지 청크 임베딩 채워짐(§5).
7. **하위호환**: 기존 CLI/테스트가 `ingestSource(wikiId, input, userId)`를 그대로 호출 → 동기 완료 + `IngestResult` 반환.
8. **UI**: 위키 홈에서 Ingest 제출 → `?run=<id>` 배지가 pending/running/done 표시(§6.2). 수동 "새 페이지" 저장은 임베딩 없이 즉시 완료(§6.3).
9. **타입/빌드**: `pnpm tsc --noEmit` 클린(특히 `reindexPage`/`reindexSource` 반환 축소가 호출부 무영향인지).
