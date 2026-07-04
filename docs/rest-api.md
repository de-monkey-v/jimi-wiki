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

- 분당 60회, 시간당 1000회.
- 초과 시 `429 { "error": "rate_limited" }` + `Retry-After: <초>` 헤더. 이 값만큼 대기 후 재시도.
- (단일 인스턴스 인메모리 구현 — 수평 확장 시 공유 스토어로 교체 필요.)

## 세션 전용 라우트 (API 키 불가)

내부 AI(Gemini)를 대량 소비하는 라우트는 **쿠키 세션(웹 UI)** 으로만 열린다 — "인증 경계 = 비용 경계". API 키/Bearer로 호출하면 인증 거부된다.

| 라우트 | 비고 |
|---|---|
| `POST /ingest` | 내부 AI ingest 에이전트. Bearer면 `401`(세션 없음) |
| `POST /query` | 검색+합성 답변 |
| `POST /reindex` | 임베딩 대량 backfill |
| `POST /lint` `{deep:true}` | agentic deep lint. Bearer면 `403 forbidden_deep_requires_session` |

> API 키 경로에서는 이들 대신 **primitive**(`POST /sources` + `POST /pages`)로 직접 작성하고, 얕은 점검은 `POST /lint`(deep 없이)를 쓴다.

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
{ "slug": "옵션", "title": "필수", "kind": "note|concept|entity|answer|meta",
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
파생 페이지(`concept`/`entity`/`answer`/`meta`)만 삭제. 관련 검색 청크도 정리된다. 상호참조 깨짐은 lint로 이연.
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

#### `GET /search?q=&k=` — 하이브리드 검색 (viewer)
`q` 질의(빈 값이면 `{ hits: [] }`), `k` 결과 수(1–50, 기본값 서버 상수). `200`: `{ hits: [...] }`

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

### 비동기 잡 폴링

#### `GET /runs/{runId}` — 잡 상태 (viewer)
내부 AI 잡(ingest 등)은 즉시 `{ runId }`를 반환하고 백그라운드로 돈다. 상태를 폴링한다.
`200`: `{ runId, status: "pending"|"running"|"done"|"error", output?, error? }` · 다른 위키/없는 잡 `404`.

## 에러 코드 규약

| 상태 | 의미 |
|---|---|
| `400` | 요청 오류(`invalid_json`, `*_required`, `invalid_kind`, `unknown_op` 등) |
| `401` | 미인증 — 키 없음/만료/폐기, 또는 세션 전용 라우트에 Bearer. `WWW-Authenticate: Bearer` |
| `403` | 인증됐으나 역할 부족(`forbidden`), `forbidden_save`, `forbidden_deep_requires_session`, `cannot_delete_system_page` |
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
