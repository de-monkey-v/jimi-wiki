# 도구 레퍼런스 — capability ↔ MCP ↔ REST

이 스킬의 워크플로우는 **능력(capability)** 기준으로 서술된다. 실행 경로는 두 가지이며, **같은 콘텐츠 API**를 가리키므로 어느 쪽을 써도 결과가 같다:

- **MCP** — `mcp/server.mjs`를 MCP 클라이언트에 등록하면 아래 도구가 노출된다(연결법은 [`setup.md`](./setup.md)).
- **REST** — MCP가 없는 하네스(예: bash+curl만 있는 환경)는 REST를 직접 호출한다. 모든 요청은 `Authorization: Bearer <API_KEY>` 헤더. 베이스: `{BASE}/api/wikis/{SLUG}`.

전체 엔드포인트·응답 스키마·에러 코드는 저장소의 [`docs/rest-api.md`](../../../docs/rest-api.md)가 정본이다. 아래 표는 스킬 워크플로우에 필요한 최소 집합.

## 매핑 표

| 능력 | MCP 도구 | REST | 비고 |
|---|---|---|---|
| 하이브리드 검색 | `search_wiki(query, k?, graph?, depth?)` | `GET /search?q=&k=&graph=1&depth=` | BM25+임베딩. 쓰기 전 중복 확인. `graph=1`이면 지식그래프 이웃을 `neighbors`로 함께 반환 |
| 페이지 목록 | `list_pages()` | `GET /pages` | slug·title·kind·category |
| 페이지 조회 | `read_page(slug)` | `GET /pages/{slug}` | 본문 포함 |
| 페이지 생성/수정 | `write_page({slug?, title, kind, body, category?, sourceSlug?, embed?})` | `POST /pages` | slug 생략=신규, 주면 수정 |
| 페이지 삭제 | `delete_page(slug)` — **기본 미노출** | `DELETE /pages/{slug}` | MCP는 `JIMI_MCP_ALLOW_DESTRUCTIVE=1`일 때만 노출(자율 에이전트 보호). 파생(concept/entity/meta)·출처 없는 정크 note는 삭제 가능. 원문 연결된 note=409, system=403 |
| 원문 목록 | `list_sources()` | `GET /sources` | 본문 제외 |
| 원문 조회 | `read_source(slug)` | `GET /sources/{slug}` | 불변 |
| 원문 저장 | `create_source({title, body, url?})` | `POST /sources` | → `{slug}` 반환. ingest 1단계 |
| 온톨로지 조회 | `get_ontology()` | `GET /ontology` | category 인스턴스·관계 어휘. 재사용 후보 확인 |
| 카테고리 매칭 | `match_category(text)` | `POST /categories/match` | 텍스트→가장 가까운 기존 category(자동 병합 아님) |
| 기계 lint | `run_lint()` | `POST /lint` | 고아·깨진 링크·정크 노트·원문 중복·카테고리 건강 + 건강 점수. 얕은 점검만 |
| 잡 상태 폴링 | `get_run_status(runId)` | `GET /runs/{runId}` | `pending`\|`running`\|`done`\|`error`. 위임형 ingest 완료 확인 |
| 위임형 편입(URL) | `ingest_url(url)` | `POST /ingest {url}` | 앱 ingest 파이프라인에 위임(비동기 → `{runId}`). 생성 쿼터 소모 |
| 위임형 편입(텍스트) | `ingest_text(text, title?)` | `POST /ingest {text,title}` | 위와 동일 |
| 읽을거리 담기 | `save_link(url, note?)` | `POST /saved-links` | read-later 개인 리스트(위키 편입 아님). 같은 URL 재요청은 기존 항목 반환 |
| 읽을거리 목록 | `list_saved_links()` | `GET /saved-links` | 최신순. `promotedAt`이 있으면 편입 완료 |

## write_page 필드

- `kind` (필수): `note` | `concept` | `entity` | `answer` | `meta`. 닫힌 집합, 새 kind 금지.
- `body` (필수): 마크다운. 내부 링크는 `[[slug]]` 또는 `[[slug|표시명]]`.
- `category` (선택): 파생 페이지의 분류 경로(예: `ai/architectures`). **note에는 붙이지 않는다.** 기존 category 재사용 우선([`ontology-rules.md`](./ontology-rules.md) §3).
- `sourceSlug`: 근거 원문 slug. **note는 필수**(없으면 `note_requires_source` 거부) — provenance로 연결된다. 파생 페이지는 선택 — 기여(contribution)로 기록된다.
- `embed` (선택): `true`면 위키의 미색인 청크 전체를 임베딩(시맨틱 검색 반영). **작업의 마지막 write_page 1회**에만 넣으면 충분하다.

## 인증 경계 — 무엇이 API 키로 되고 안 되나

> "인증 경계 = 비용 경계." 내부 AI(Gemini)를 대량 소비하는 라우트는 원칙적으로 **웹 UI 쿠키 세션 전용**이다. 유일한 예외가 `POST /ingest`이며, 그 대신 API 키 경로에도 세션과 **동일한 일일 생성 쿼터**가 걸린다.

- **API 키/MCP로 가능**: 위 표의 모든 도구 — 조회·작성·삭제, 원문 저장/조회, 하이브리드 검색(+graph), 온톨로지, 기계 lint, 읽을거리, **위임형 ingest와 잡 폴링**.
- **세션 전용(API 키 불가)**: `POST /query`, `POST /reindex`, `POST /lint {deep:true}`. 외부 에이전트는 자기 LLM이 있으므로 `/query` 대신 `search_wiki`로 근거를 받아 스스로 종합한다.
- **ingest 쿼터**: 위키 소유자의 일일 토큰 상한(`DAILY_TOKEN_LIMIT`)을 넘으면 `429 daily_quota_exceeded`. `Retry-After`가 없으므로 재시도하지 말고 사용자에게 알린다.

## 편입 두 방식 — 언제 무엇을 쓰나

| | 위임형 (`ingest_url`/`ingest_text`) | 직접 큐레이션 (`create_source`+`write_page`) |
|---|---|---|
| 처리 주체 | 앱의 ingest 파이프라인(내부 AI) | 너(외부 에이전트) |
| 얻는 것 | 웹 본문추출·유튜브 자막·불변 원문 저장·초안 검토까지 자동 | 문서 구조·분류·상호참조를 네가 설계 |
| 비용 | 위키 소유자의 생성 쿼터 소모 | 네 쪽 토큰만 |
| 언제 | "이 링크 넣어줘" 같은 단순 편입 | 여러 원문 종합·기존 문서 재구성 등 판단이 필요한 작업 |

## 비동기 잡 폴링

ingest 잡은 비동기로 돌며 즉시 `{ runId }`를 반환한다. 완료는 폴링으로 확인한다:

```sh
# status: pending | running | done | error. done이면 output, error면 error.
curl -sH "Authorization: Bearer $KEY" "$JIMI_WIKI_URL/api/wikis/$SLUG/runs/$RUN_ID"
```

MCP에서는 `get_run_status(runId)`가 같은 일을 한다. 워커가 처리하므로 즉시 완료되지 않는다 — 몇 초 간격으로 폴링하라.

> `status: "error"`인데 `published: true`가 붙어 있으면 **콘텐츠는 이미 발행됐고 검색 색인만 미완**이다. 재편입하면 중복이 되므로 재시도하지 말고 사용자에게 그대로 알린다.
