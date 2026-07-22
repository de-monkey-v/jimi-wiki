# jimi-wiki REST API

외부 에이전트/스크립트가 앱 내부 AI 없이 위키를 유지보수하기 위한 콘텐츠 API 레퍼런스. 워크플로우(ingest 절차·분류 규칙)는 [`skills/wiki-ingest/SKILL.md`](../skills/wiki-ingest/SKILL.md), 도구 래퍼는 [`mcp/server.mjs`](../mcp/server.mjs) 참조.

## 베이스 URL

```
http://localhost:3007/api/wikis/{slug}
```

`{slug}`는 대상 위키의 slug. 배포 환경에서는 호스트만 바뀐다.

## 인증

프로그램 호출은 **API 키(Bearer)** 로 인증한다. 웹 UI는 쿠키 세션을 쓰며, 아래 "세션 전용 라우트"는 API 키로 접근할 수 없다.

```
Authorization: Bearer <API_KEY>
```

- 키 발급: 로그인 후 `/keys`. 원문 키는 발급 시 한 번만 표시된다(서버는 sha256 해시만 저장).
- **스코프 위키**: 키를 특정 위키로 제한할 수 있다. 스코프 밖 위키 요청은 존재를 숨겨 `404`.
- **상한 역할(maxRole)**: 유효 역할 = `min(멤버십 역할, maxRole)`. `viewer < editor < owner`. 예) editor 멤버가 `maxRole=viewer` 키를 쓰면 쓰기 라우트에서 `403`.
- **만료(expiresAt)**: 지난 키는 인증 실패(`401`). **폐기(revokedAt)**: 폐기된 키도 `401`.
- 계정당 활성 키는 최대 20개.

## 레이트리밋

인증 성공 후 **키 단위**(키 없으면 사용자 단위)로 토큰버킷을 적용한다.

- 분당 120회, 시간당 3000회.
- 초과 시 `429 { "error": "rate_limited" }` + `Retry-After: <초>` 헤더. 이 값만큼 대기 후 재시도.
- (단일 인스턴스 인메모리 구현 — 수평 확장 시 공유 스토어로 교체 필요.)

## 세션 전용 라우트 (API 키 불가)

내부 AI(Gemini)를 대량 소비하는 라우트는 **쿠키 세션(웹 UI)** 으로만 열린다 — "인증 경계 = 비용 경계". API 키/Bearer로 호출하면 인증 거부된다.

| 라우트 | 비고 |
|---|---|
| `POST /query` | 검색+합성 답변 |
| `POST /reindex` | 임베딩 대량 backfill |
| `POST /lint` `{deep:true}` | agentic deep lint. Bearer면 `403 forbidden_deep_requires_session` |

> API 키 경로에서는 `/query` 대신 `GET /search`로 근거를 받아 호출자가 직접 종합하고, 얕은 점검은 `POST /lint`(deep 없이)를 쓴다.

**예외 — `POST /ingest`**: 외부 에이전트도 앱의 ingest 파이프라인을 쓸 수 있도록 API 키에 열려 있다. 생성형 처리를 하는 `mode=curate`에만 세션과 동일한 **일일 생성 토큰 쿼터**(`DAILY_TOKEN_LIMIT`, 키 소유 사용자 기준)가 적용되고, `mode=preserve`는 이 쿼터를 소비하지 않는다.

## 라우트 (API 키 접근 가능)

역할은 **최소 요구 역할**. 명시 없으면 `viewer`.

### 페이지

#### `GET /pages` — 목록 (viewer)
응답 `200`: `{ pages: [{ id, slug, title, kind, documentType?, documentAt?, category, currentVersion, updatedAt }] }`

#### `GET /pages/{pageSlug}` — 단건 (viewer)
응답 `200`: `{ slug, title, kind, documentType?, documentAt?, category, body, origin, modelAccess, currentVersion }` · 없으면 `404 not_found`

#### `POST /pages` — 생성/수정 (editor)
요청:
```json
{ "slug": "옵션", "title": "필수", "kind": "note|concept|entity|meta",
  "body": "마크다운 필수", "category": "옵션(파생만)", "sourceSlug": "옵션",
  "embed": false, "expectedVersion": 3 }
```
- `slug` 생략 시 `title`에서 유도. 기존 slug면 수정.
- `kind`는 명시 필수이며 위 4종만 이 primitive에 사용한다. `document` 신규 생성은 `/documents`, `personal`은 웹 UI 전용이다.
- 기존 slug 수정에는 읽은 `currentVersion`을 `expectedVersion`으로 보내야 한다. 누락 `400 expected_version_required`, 충돌 `409 version_conflict`.
- `note`에는 `category`가 무시된다(소스 노트 순수성). `category`는 서버측 온톨로지 정규화를 거친다.
- `sourceSlug`: `note`면 provenance(`sourceId`)로, 파생 페이지면 기여(contribution)로 연결. 없는 원문이면 `400 source_not_found`.
- `embed:true`면 미색인 청크 전체를 임베딩(작업 마지막 1회 권장).

외부 에이전트가 사람 작성/혼합 페이지를 수정하면 직접 덮지 않고 `202 { staged:true, buildId, draftId, currentVersion }`를 반환한다.

응답: 생성 `201` / 수정 `200` — `{ slug, created, embedded, currentVersion }`
오류: `400 invalid_json | title_and_body_required | invalid_kind | source_not_found`

#### `DELETE /pages/{pageSlug}` / `POST /pages/{pageSlug}/restore` — 휴지통/복원 (editor)
페이지를 14일 복구 가능한 휴지통으로 옮기거나 복원한다. `expectedVersion` query 또는 `X-Jimi-Expected-Version` 헤더를 권장한다. source 연결 note는 Source 단위로 처리해야 하며 보호 메모·예약 페이지는 외부 모델에서 보이지 않는다. 영구 삭제는 휴지통 항목에 한해 웹 owner 세션 + `permanent=1` + `X-Jimi-Confirm-Purge: <slug>`로만 가능하다.

### 원문(Source) — 불변

#### `GET /sources` — 목록 (viewer)
`200`: `{ sources: [{ slug, title, url, curationState, ingestedAt }] }`

#### `GET /sources/{sourceSlug}` — 단건 (viewer)
`200`: `{ slug, title, url, body, curationState, ingestedAt }` · 없으면 `404`

#### `POST /sources` — 저장 (editor)
요청 `{ title, body, url? }`. 불변 저장 후 FTS 색인. 응답 `201`: `{ slug }`
오류: `400 invalid_json | title_and_body_required`

#### `POST /sources/{sourceSlug}/curate` — 보존 원문 정리 (editor)
`curationState=preserved`인 Source를 비동기 KnowledgeBuild에 넣는다. `202 { runId, status:"pending", reused }`. 동시에 재호출하면 같은 pending/running run을 반환한다. preserve 시 외부 OCR을 생략한 blob-only 파일은 이때 원본 blob을 다시 추출하고, 추출 본문을 새 불변 SourceRevision으로 저장해 build 근거로 쓴다. 발행 성공 뒤에만 Source가 `curated`로 전환된다. 이미 curated면 `200 { alreadyCurated:true }`.

#### `DELETE /sources/{sourceSlug}` / `POST /sources/{sourceSlug}/restore` — 휴지통/복원 (editor)
Source와 연결 source note를 함께 14일 휴지통으로 이동하거나 복원한다. 영구 삭제는 페이지와 동일하게 이미 휴지통인 항목에 대한 웹 owner 세션 확인이 필요하다.

### 독립 문서(document)

`document`는 Source provenance를 갖지 않으며 검색·위키링크에는 참여하지만 concept/entity 관계 그래프·고아 개념 lint·KnowledgeBuild 자동 재작성 대상에서는 제외된다.

#### `POST /documents` — 생성/수정 (editor)
```json
{
  "slug": "기존 수정 시만", "title": "필수", "body": "마크다운",
  "type": "general|worklog|troubleshooting|decision|reference|plan|spec",
  "documentAt": "2026-07-21T12:30:00+09:00", "category": "옵션",
  "expectedVersion": 3
}
```
slug 생략은 항상 신규(create-only). 기존 slug 수정은 `expectedVersion` 필수다. 에이전트 생성 문서는 CAS로 직접 갱신하고 사람/혼합 문서는 `202 {staged:true}` 검토 초안을 만든다. `sourceId|sourceSlug|sourceRevisionIds`를 보내면 `400 document_source_provenance_forbidden`. 비밀 키 패턴은 `400 secret_material_rejected`.

#### `GET /documents?type=&from=&to=` — 목록 (viewer)
`documentAt desc` 순으로 최대 200개. 날짜 범위와 DocumentType을 필터링한다.

#### `POST /documents/{pageSlug}/append` — 끝에 추가 (editor)
body `{ "content":"추가할 마크다운", "expectedVersion":3 }`. document 전용이며 append 64 KiB, 전체 본문 1 MiB 상한. 동시 CAS 충돌은 한쪽이 `409 version_conflict`; 사람/혼합 문서는 직접 덮지 않고 staged review를 반환한다.

### 검색 · 온톨로지

#### `GET /search?q=&k=&scope=&graph=&depth=` — 하이브리드 검색 (viewer)
`scope=knowledge|documents|all`. 생략은 기존 호환을 위해 `knowledge`. `knowledge`에는 curated Source와 그 note, concept/entity가 들어가고 `documents`에는 preserved Source와 document가 들어간다. `all`은 정본 지식이 작업 기록에 밀리지 않도록 `{ groups:{ knowledge:{hits}, documents:{hits} } }`로 분리한다. 잘못된 scope는 `400 invalid_search_scope`.

`graph=1`을 주면 히트한 페이지를 시드로 지식그래프(`ConceptRelation`)를 순회해 이웃 페이지를 함께 반환한다 — `200`: `{ hits, neighbors: [{ pageId, slug, title, snippet, depth }] }`. `depth`는 홉수(기본 1)이며 서버 상한 `KG_MAX_HOP`으로 clamp된다(`KG_MAX_HOP=0`이면 확장이 꺼져 `neighbors: []`). `graph`를 주지 않으면 응답에 `neighbors` 키가 없다(하위호환).

#### `GET /ontology` — 분류 인스턴스 (viewer)
`200`: `{ ontology: { categories, relations, ... } }`

#### `POST /categories/match` — 재사용 후보 (viewer)
요청 `{ text }`. `200`: `{ candidates: [{ slug, label?, score }] }` (문자열+임베딩 병합, 자동 병합 아님)
오류: `400 invalid_json | text_required`

#### `POST /ontology/change` — 거버넌스 (editor)
요청(택1):
```json
{ "op": "rename", "from": "a", "to": "b" }
{ "op": "merge",  "from": "a", "into": "b" }
{ "op": "retire", "slug": "a", "reassignTo": "b(옵션)" }
```
`200`: `{ ok: true }` · 오류: `400 unknown_op | invalid_json | <메시지>`

### Lint

#### `POST /lint` — 기계 점검 (editor)
요청 `{}` 또는 생략. 내부 LLM 없이 고아 페이지·깨진 링크·index 불일치 등을 점검. `200`: 리포트 JSON.
`{deep:true}`는 세션 전용(위 표) — Bearer면 `403 forbidden_deep_requires_session`.

### 편입(ingest)

#### `POST /ingest` — 위임형 편입 (editor)
앱의 ingest 파이프라인에 맡긴다. 비동기 — `202`: `{ runId, status: "pending" }`.

- body: `{ url, mode? }` 또는 `{ text, title?, mode? }` (JSON). `mode` 생략은 `curate`; 잘못된 값은 `400 invalid_ingest_mode`.
- `mode=preserve`: 불변 Source/SourceRevision + 원문 위치만 가리키는 deterministic note + FTS/허용 임베딩. KnowledgeBuild·생성형 큐레이션을 실행하지 않고 완료 output에 `outcome:"preserved"`를 담는다. 외부 OCR이 필요한 파일은 blob만 보존하며 `textExtracted:false`.
- ZIP의 `curate` 부모 run은 child run 등록만 마치므로 `outcome:"delegated"`를 반환한다. 실제 `curated` 성공 여부는 각 child run에서 확인한다.
- `mode=curate`: 기존 Source→note→concept/entity 합성 흐름. 기존 호출과 동일하다.
- 파일 업로드(`multipart/form-data`의 `file[]`)는 **세션 전용**이다 — 한 요청이 파일 수만큼 잡을 만들어 요청당 1회인 비용 검사와 어긋나므로, Bearer로 호출하면 `403 file_upload_requires_session`.
- `curate`만 일일 생성 쿼터를 소모한다. `preserve`는 생성형 쿼터를 소비하지 않는다. ZIP child run은 부모 mode를 상속한다.
- 완료는 `GET /runs/{runId}` 폴링으로 확인한다.

### 읽을거리(read-later)

읽을거리는 위키 콘텐츠가 아니라 **키 소유 사용자의 개인 리스트**다.

#### `GET /saved-links?state=active|trash|all` — 목록 (viewer)
기본은 active. `200`: `{ links: [{ id, url, title, description, summary, trashedAt, purgeAt, promotedAt, promotedRunId, promotedRun:{status,error}?, createdAt }] }`. `promotedAt`이 있으면 편입 완료이고, 실패·진행 중이면 연결된 run 상태를 확인한다.

#### `POST /saved-links` — 담기 (viewer)
body `{ url, summary? }`. REST primitive 자체는 LLM을 호출하지 않으며 `summary`가 없으면 제목·사이트 설명만 추출한다. Hermes/MCP의 `save_link`는 호출 전에 항상 본문을 읽어 **핵심 bullet 3~5개 + ‘볼 가치’ 한 문장**을 전달해야 하고, 본문 추출 실패 때만 구체적 실패 사유와 함께 메타데이터 저장으로 폴백한다. `summary`는 최대 2,000자다. 서버는 `utm_*`, `fbclid`, `gclid` 등 추적 파라미터를 제거하되 의미 있는 query·fragment는 보존한다.
`201`: 신규 · 동일 정규화 URL은 `200 { existing:true }` · 휴지통에 있던 동일 URL은 복원한다. 오류는 `400 invalid_url|invalid_summary|summary_too_large`.

#### `DELETE /saved-links/{id}` / `POST /saved-links/{id}/restore` — 휴지통/복원 (viewer)
키 소유 사용자의 읽을거리를 14일 휴지통으로 옮기거나 복원한다.

#### `GET /trash` — 외부 에이전트 휴지통 (viewer)
`{ savedLinks, pages, sources }`. 외부 AI가 복원할 수 있는 항목만 노출하며, `personal/internalOnly`·system·위키 전체와 영구 purge는 포함하지 않는다.

#### `POST /saved-links/{id}/promote` — 정식 편입 (editor)
SavedLink를 `mode=curate` ingest로 승격한다. 최초 호출은 `202 { runId, status:"pending", reused:false }`. `promotedRunId`를 저장하므로 동시 호출과 네트워크 재시도는 같은 run을 반환한다. run 실패는 `promotedAt`을 세우지 않으며 응답/목록에서 해당 run의 `error` 상태를 그대로 보여준다.

### 비동기 잡 폴링

#### `GET /runs/{runId}` — 잡 상태 (viewer)
ingest 잡은 즉시 `{ runId }`를 반환하고 백그라운드(worker)로 돈다. 상태를 폴링한다.

`status: "error"`에 `published: true`가 함께 오면 **콘텐츠는 발행됐고 파생 색인만 미완**인 상태다(`publishedDegraded` 빌드). 이 경우 `output`도 함께 반환되며, 재편입하면 중복이 된다 — 재색인은 웹 UI에서 재시도한다.
`200`: `{ runId, status: "pending"|"running"|"done"|"error", output?, error? }` · 다른 위키/없는 잡 `404`.

## 에러 코드 규약

| 상태 | 의미 |
|---|---|
| `400` | 요청 오류(`invalid_json`, `*_required`, `invalid_kind`, `unknown_op` 등) |
| `401` | 미인증 — 키 없음/만료/폐기, 또는 세션 전용 라우트에 Bearer. `WWW-Authenticate: Bearer` |
| `403` | 인증됐으나 역할 부족(`forbidden`), `forbidden_deep_requires_session`, `cannot_delete_system_page` |
| `404` | 위키/리소스 없음, 또는 키 스코프 밖(존재 은폐) |
| `409` | 상태 충돌 — `version_conflict`, `not_a_document`, `cannot_delete_source_note` 등 |
| `429` | 레이트리밋 — `Retry-After` 헤더 |
| `500` | 서버 오류 — `{ error: "<메시지>" }` |

## curl 예제

```bash
KEY="jw_..."; BASE="http://localhost:3007/api/wikis/ai-스터디"

# 페이지 목록
curl -sH "Authorization: Bearer $KEY" "$BASE/pages"

# 원문 저장(1단계) → slug 반환
curl -sX POST "$BASE/sources" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"title":"Attention Is All You Need","body":"...원문 전문...","url":"https://..."}'

# 소스 노트 작성(kind=note, sourceSlug 연결)
curl -sX POST "$BASE/pages" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"title":"Transformer 노트","kind":"note","body":"핵심 요약...","sourceSlug":"attention-is-all-you-need"}'

# 개념 페이지 + 마지막에 임베딩 색인
curl -sX POST "$BASE/pages" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"title":"Self-Attention","kind":"concept","category":"ai/architectures","body":"[[transformer-노트]] 참조...","embed":true}'

# 검색
curl -sH "Authorization: Bearer $KEY" "$BASE/search?q=attention&k=8"

# 페이지를 14일 휴지통으로 이동
curl -sX DELETE "$BASE/pages/self-attention" -H "Authorization: Bearer $KEY"

# 기계 점검
curl -sX POST "$BASE/lint" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}'
```
