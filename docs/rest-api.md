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

**예외 — `POST /ingest`**: 외부 에이전트도 앱의 ingest 파이프라인을 쓸 수 있도록 API 키에 열려 있다. 대신 비용 경계를 지키기 위해 API 키 경로에도 세션과 동일한 **일일 생성 토큰 쿼터**(`DAILY_TOKEN_LIMIT`, 키 소유 사용자 기준)가 적용된다.

## 라우트 (API 키 접근 가능)

역할은 **최소 요구 역할**. 명시 없으면 `viewer`.

### 페이지

#### `GET /pages` — 목록 (viewer)
응답 `200`: `{ pages: [{ id, slug, title, kind, updatedAt }] }`

#### `GET /pages/{pageSlug}` — 단건 (viewer)
응답 `200`: `{ slug, title, kind, category, body }` · 없으면 `404 not_found`

#### `POST /pages` — 생성/수정 (editor)
요청:
```json
{ "slug": "옵션", "title": "필수", "kind": "note|concept|entity|meta",
  "body": "마크다운 필수", "category": "옵션(파생만)", "sourceSlug": "옵션", "embed": false }
```
- `slug` 생략 시 `title`에서 유도. 기존 slug면 수정.
- `kind`는 5종 enum. 잘못된 값 → `400 invalid_kind`. 생략 시 `note`.
- `note`에는 `category`가 무시된다(소스 노트 순수성). `category`는 서버측 온톨로지 정규화를 거친다.
- `sourceSlug`: `note`면 provenance(`sourceId`)로, 파생 페이지면 기여(contribution)로 연결. 없는 원문이면 `400 source_not_found`.
- `embed:true`면 미색인 청크 전체를 임베딩(작업 마지막 1회 권장).

응답: 생성 `201` / 수정 `200` — `{ slug, created, embedded }`
오류: `400 invalid_json | title_and_body_required | invalid_kind | source_not_found`

#### `DELETE /pages/{pageSlug}` — 삭제 (editor)
파생 페이지(`concept`/`entity`/`meta`)만 삭제. 관련 검색 청크도 정리된다. 상호참조 깨짐은 lint로 이연.
- 응답 `200`: `{ deleted: true, slug }`
- `404 not_found` · `409 cannot_delete_source_note`(note는 불변) · `403 cannot_delete_system_page`(ontology 등 예약 슬러그)

### 원문(Source) — 불변

#### `GET /sources` — 목록 (viewer)
`200`: `{ sources: [{ slug, title, url, ingestedAt }] }`

#### `GET /sources/{sourceSlug}` — 단건 (viewer)
`200`: `{ slug, title, url, body, ingestedAt }` · 없으면 `404`

#### `POST /sources` — 저장 (editor)
요청 `{ title, body, url? }`. 불변 저장 후 FTS 색인. 응답 `201`: `{ slug }`
오류: `400 invalid_json | title_and_body_required`

### 검색 · 온톨로지

#### `GET /search?q=&k=&graph=&depth=` — 하이브리드 검색 (viewer)
`q` 질의(빈 값이면 `{ hits: [] }`), `k` 결과 수(1–50, 기본값 서버 상수). `200`: `{ hits: [...] }`

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
앱의 ingest 파이프라인에 맡긴다(웹 본문추출·유튜브 자막·불변 원문 저장·초안 검토). 비동기 — `202`: `{ runId, status: "pending" }`.

- body: `{ url }` 또는 `{ text, title? }` (JSON).
- 파일 업로드(`multipart/form-data`의 `file[]`)는 **세션 전용**이다 — 한 요청이 파일 수만큼 잡을 만들어 요청당 1회인 비용 검사와 어긋나므로, Bearer로 호출하면 `403 file_upload_requires_session`.
- 내부 AI를 쓰므로 일일 생성 쿼터를 소모한다. 초과 시 `429 { error: "daily_quota_exceeded", used, limit }` (`Retry-After` 없음 — 재시도해도 소용없다).
- 완료는 `GET /runs/{runId}` 폴링으로 확인한다.

### 읽을거리(read-later)

읽을거리는 위키 콘텐츠가 아니라 **키 소유 사용자의 개인 리스트**다. 정식 편입(promote)은 웹 UI에서 사람이 수행한다.

#### `GET /saved-links` — 목록 (viewer)
`200`: `{ links: [{ id, url, title, description, promotedAt, createdAt }] }` (최신순). `promotedAt`이 있으면 이미 위키로 편입된 링크.

#### `POST /saved-links` — 담기 (viewer)
body `{ url, note? }`. 제목·설명은 자동 추출하며(LLM 미사용), `note`를 주면 설명 대신 그 값을 저장한다.
`201`: `{ link }` · 같은 URL이 이미 있으면 새로 만들지 않고 `200`: `{ link, existing: true }` · 잘못된 URL은 `400 invalid_url`.
중복 방지는 조회-후-쓰기다 — 동시 요청이 겹치거나 URL 문자열이 다르면(끝슬래시·`utm_*` 등) 중복 행이 생길 수 있다(유니크 제약 없음).

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
| `409` | 상태 충돌 — `cannot_delete_source_note` |
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

# 파생 페이지 삭제
curl -sX DELETE "$BASE/pages/self-attention" -H "Authorization: Bearer $KEY"

# 기계 점검
curl -sX POST "$BASE/lint" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}'
```
