# 도구 레퍼런스 — capability ↔ MCP ↔ REST

이 스킬의 워크플로우는 **능력(capability)** 기준으로 서술된다. 실행 경로는 두 가지이며, **같은 콘텐츠 API**를 가리키므로 어느 쪽을 써도 결과가 같다:

- **MCP** — `mcp/server.mjs`를 MCP 클라이언트에 등록하면 아래 도구가 노출된다(연결법은 [`setup.md`](./setup.md)).
- **REST** — MCP가 없는 하네스(예: bash+curl만 있는 환경)는 REST를 직접 호출한다. 모든 요청은 `Authorization: Bearer <API_KEY>` 헤더. 베이스: `{BASE}/api/wikis/{SLUG}`.

전체 엔드포인트·응답 스키마·에러 코드는 저장소의 [`docs/rest-api.md`](../../../docs/rest-api.md)가 정본이다. 아래 표는 스킬 워크플로우에 필요한 최소 집합.

## 매핑 표

| 능력 | MCP 도구 | REST | 비고 |
|---|---|---|---|
| 하이브리드 검색 | `search_wiki(query, k?)` | `GET /search?q=&k=` | BM25+임베딩. 쓰기 전 중복 확인 |
| 페이지 목록 | `list_pages()` | `GET /pages` | slug·title·kind·category |
| 페이지 조회 | `read_page(slug)` | `GET /pages/{slug}` | 본문 포함 |
| 페이지 생성/수정 | `write_page({slug?, title, kind, body, category?, sourceSlug?, embed?})` | `POST /pages` | slug 생략=신규, 주면 수정 |
| 페이지 삭제 | `delete_page(slug)` | `DELETE /pages/{slug}` | 파생(concept/entity/answer/meta)·출처 없는 정크 note는 삭제 가능. 원문 연결된 note=409, system=403 |
| 원문 목록 | `list_sources()` | `GET /sources` | 본문 제외 |
| 원문 조회 | `read_source(slug)` | `GET /sources/{slug}` | 불변 |
| 원문 저장 | `create_source({title, body, url?})` | `POST /sources` | → `{slug}` 반환. ingest 1단계 |
| 온톨로지 조회 | `get_ontology()` | `GET /ontology` | category 인스턴스·관계 어휘. 재사용 후보 확인 |
| 카테고리 매칭 | `match_category(text)` | `POST /categories/match` | 텍스트→가장 가까운 기존 category(자동 병합 아님) |
| 기계 lint | `run_lint()` | `POST /lint` | 고아·깨진 링크·정크 노트·원문 중복·카테고리 건강 + 건강 점수. 얕은 점검만 |
| 잡 상태 폴링 | (MCP 미노출) | `GET /runs/{runId}` | 읽기라 API 키 가능. 웹 UI 잡 추적용 |

## write_page 필드

- `kind` (필수): `note` | `concept` | `entity` | `answer` | `meta`. 닫힌 집합, 새 kind 금지.
- `body` (필수): 마크다운. 내부 링크는 `[[slug]]` 또는 `[[slug|표시명]]`.
- `category` (선택): 파생 페이지의 분류 경로(예: `ai/architectures`). **note에는 붙이지 않는다.** 기존 category 재사용 우선([`ontology-rules.md`](./ontology-rules.md) §3).
- `sourceSlug`: 근거 원문 slug. **note는 필수**(없으면 `note_requires_source` 거부) — provenance로 연결된다. 파생 페이지는 선택 — 기여(contribution)로 기록된다.
- `embed` (선택): `true`면 위키의 미색인 청크 전체를 임베딩(시맨틱 검색 반영). **작업의 마지막 write_page 1회**에만 넣으면 충분하다.

## 인증 경계 — 무엇이 API 키로 되고 안 되나

> "인증 경계 = 비용 경계." 내부 AI(Gemini)를 대량 소비하는 라우트는 **웹 UI 쿠키 세션 전용**이라 API 키/MCP로는 호출할 수 없다.

- **API 키/MCP로 가능**: 위 표의 모든 도구 — 페이지 조회/작성/삭제, 원문 저장/조회, 하이브리드 검색, 온톨로지 조회·매칭, 기계 lint, 잡 폴링.
- **세션 전용(API 키 403/불가)**: `POST /ingest`(내부 AI ingest), `POST /query`, `POST /reindex`, `POST /lint {deep:true}`. **외부 경로에서는 이 앱 내부 AI ingest를 쓰지 말고**, 스킬 절차대로 `create_source` + `write_page` primitive로 직접 작성한다. (내부 AI ingest가 필요하면 웹 UI를 사용.)

## 비동기 잡 폴링

내부 AI 잡(웹 UI ingest, deep lint)은 비동기로 돌며 즉시 `{ runId }`를 반환한다. 상태는 폴링으로 확인(읽기라 API 키 가능):

```sh
# status: pending | running | done | error. done이면 output, error면 error.
curl -sH "Authorization: Bearer $KEY" "$JIMI_WIKI_URL/api/wikis/$SLUG/runs/$RUN_ID"
```

API 키/MCP 경로에서는 내부 AI 잡을 **트리거**할 수 없다 — 이 폴링은 웹 UI에서 시작한 잡을 추적하거나 REST 소비자가 자기 잡 상태를 볼 때만 쓴다.
