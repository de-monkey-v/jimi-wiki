# 도구 레퍼런스 — capability ↔ MCP ↔ REST

이 스킬의 워크플로우는 **능력(capability)** 기준으로 서술된다. 실행 경로는 두 가지이며, **같은 콘텐츠 API**를 가리키므로 어느 쪽을 써도 결과가 같다:

- **MCP** — `mcp/server.mjs`를 MCP 클라이언트에 등록하면 아래 도구가 노출된다(연결법은 [`setup.md`](./setup.md)).
- **REST** — MCP가 없는 하네스(예: bash+curl만 있는 환경)는 REST를 직접 호출한다. 모든 요청은 `Authorization: Bearer <API_KEY>` 헤더. 베이스: `{BASE}/api/wikis/{SLUG}`.

전체 엔드포인트·응답 스키마·에러 코드는 저장소의 [`docs/rest-api.md`](../../../docs/rest-api.md)가 정본이다. 아래 표는 스킬 워크플로우에 필요한 최소 집합.

## 매핑 표

| 능력 | MCP 도구 | REST | 비고 |
|---|---|---|---|
| 지식 검색 | `search_wiki(query, k?, graph?, depth?)` | `GET /search?q=&scope=knowledge` | curated 원문·note·concept/entity. 기본 scope |
| 문서 검색 | `search_documents(query?, type?, from?, to?)` | `GET /search?...&scope=documents` 또는 `GET /documents` | preserve 원문과 document를 지식 결과와 분리 |
| 페이지 목록 | `list_pages()` | `GET /pages` | slug·title·kind·category |
| 페이지 조회 | `read_page(slug)` | `GET /pages/{slug}` | 본문 포함 |
| 페이지 생성/수정 | `write_page({slug?, title, kind, body, category?, sourceSlug?, embed?})` | `POST /pages` | slug 생략=신규, 주면 수정 |
| 페이지 휴지통/복원 | `trash_page` / `restore_page` | `DELETE /pages/{slug}` / `POST /pages/{slug}/restore` | 14일 복구 가능. source note·보호 메모·system은 외부 AI에서 거부 |
| 원문 목록 | `list_sources()` | `GET /sources` | 본문 제외 |
| 원문 조회 | `read_source(slug)` | `GET /sources/{slug}` | 불변 |
| 원문 저장 | `create_source({title, body, url?})` | `POST /sources` | → `{slug}` 반환. ingest 1단계 |
| 원문 휴지통/복원 | `trash_source` / `restore_source` | `DELETE /sources/{slug}` / `POST /sources/{slug}/restore` | 연결 source note와 함께 처리, 14일 복구 가능 |
| 원문만 보존 | `preserve_url` / `preserve_text` | `POST /ingest {mode:"preserve",...}` | Source+pointer note, 생성형 큐레이션 없음 |
| 정리 편입 | `curate_url` / `curate_text` | `POST /ingest {mode:"curate",...}` | 기존 `ingest_*`도 curate 별칭 |
| 보존 원문 정리 | `curate_source(sourceSlug)` | `POST /sources/{slug}/curate` | blob-only 파일은 이때 추출/OCR 후 새 SourceRevision을 만들며, 게시 성공 뒤에만 curated 전환 |
| 문서 기록 | `record_document(...)` | `POST /documents` | `general|worklog|troubleshooting|decision|reference|plan|spec` |
| 연구 보고서 | `record_research_report(...)` | `POST /documents {type:"research"}` | preserved Source 1~30개, `[@slug]` 첫 등장 순서와 `sourceSlugs` 일치 |
| 작업 기록 | `record_worklog(...)` | `POST /documents` | 7개 고정 heading |
| 문서 추가 | `append_document(slug, content, expectedVersion)` | `POST /documents/{slug}/append` | document 전용, CAS |
| 온톨로지 조회 | `get_ontology()` | `GET /ontology` | category 인스턴스·관계 어휘. 재사용 후보 확인 |
| 카테고리 매칭 | `match_category(text)` | `POST /categories/match` | 텍스트→가장 가까운 기존 category(자동 병합 아님) |
| 기계 lint | `run_lint()` | `POST /lint` | 고아·깨진 링크·정크 노트·원문 중복·카테고리 건강 + 건강 점수. 얕은 점검만 |
| 잡 상태 폴링 | `get_run_status(runId)` | `GET /runs/{runId}` | `pending`\|`running`\|`done`\|`error`. 위임형 ingest 완료 확인 |
| 위임형 편입(URL) | `ingest_url(url)` | `POST /ingest {url}` | `curate_url` 호환 별칭 |
| 위임형 편입(텍스트) | `ingest_text(text, title?)` | `POST /ingest {text,title}` | `curate_text` 호환 별칭 |
| 읽을거리 담기 | `save_link(url, summary?, summaryUnavailableReason?)` | `POST /saved-links` | 기본 3~5 bullet+볼 가치 요약. 추출 실패 때만 사유와 함께 메타데이터 폴백. 추적 파라미터 정규화 |
| 읽을거리 목록 | `list_saved_links()` | `GET /saved-links` | 최신순. `promotedAt`이 있으면 편입 완료 |
| 읽을거리 휴지통/복원 | `trash_saved_link` / `restore_saved_link` | `DELETE /saved-links/{id}` / `POST /saved-links/{id}/restore` | 14일 복구 가능 |
| 읽을거리 승격 | `promote_saved_link(id)` | `POST /saved-links/{id}/promote` | 재시도·동시 호출은 같은 runId |
| 휴지통 목록 | `list_trash()` | `GET /trash` | MCP로 복원 가능한 항목만. 위키 전체·영구 purge는 미노출 |

## write_page 필드

- `kind` (필수): `note` | `concept` | `entity` | `meta`. `document`는 전용 문서 API를 쓰며 `personal`은 웹 UI 전용이다.
- `body` (필수): 마크다운. 내부 링크는 `[[slug]]` 또는 `[[slug|표시명]]`.
- `category` (선택): 파생 페이지의 분류 경로(예: `ai/architectures`). **note에는 붙이지 않는다.** 기존 category 재사용 우선([`ontology-rules.md`](./ontology-rules.md) §3).
- `sourceSlug`: 근거 원문 slug. **note는 필수**(없으면 `note_requires_source` 거부) — provenance로 연결된다. 파생 페이지는 선택 — 기여(contribution)로 기록된다.
- `embed` (선택): `true`면 위키의 미색인 청크 전체를 임베딩(시맨틱 검색 반영). **작업의 마지막 write_page 1회**에만 넣으면 충분하다.
- 기존 slug 수정은 `expectedVersion` 필수다. 충돌은 `409 version_conflict`; 사람/혼합 문서에 대한 외부 에이전트 수정은 `202 {staged:true}`다.

## record_research_report 필드

- `title`, `body`, `sourceSlugs`는 필수다. `sourceSlugs`는 같은 위키의 active external `curationState=preserved` Source 1~30개만 허용한다.
- 본문의 코드 블록 밖 `[@source-slug]`를 첫 등장 순서로 추출한 목록이 `sourceSlugs`와 정확히 같아야 한다. 같은 Source 재인용은 같은 번호를 쓴다.
- `slug`, `documentAt`, `category`, `expectedVersion`은 선택이다. 새 보고서 category 기본값은 `research`.
- `expectedVersion`은 명시한 기존 research slug 갱신에만 사용한다. 연구 보고서에는 `append_document`를 사용하지 않는다.

## 인증 경계 — 무엇이 API 키로 되고 안 되나

> "인증 경계 = 비용 경계." 내부 AI를 대량 소비하는 라우트는 원칙적으로 웹 UI 세션 전용이다. `POST /ingest`는 API 키에도 열려 있고, 그중 `mode=curate`에만 세션과 동일한 일일 생성 쿼터가 걸린다.

- **API 키/MCP로 가능**: 위 표의 모든 도구 — 조회·작성·복구 가능한 휴지통/복원, 원문 저장/조회, 하이브리드 검색(+graph), 온톨로지, 기계 lint, 읽을거리, **위임형 ingest와 잡 폴링**. 영구 purge와 위키 전체 삭제는 불가다.
- **세션 전용(API 키 불가)**: `POST /query`, `POST /reindex`, `POST /lint {deep:true}`. 외부 에이전트는 자기 LLM이 있으므로 `/query` 대신 `search_wiki`로 근거를 받아 스스로 종합한다.
- **ingest 쿼터**: `curate`만 위키 소유자의 일일 생성 토큰 상한(`DAILY_TOKEN_LIMIT`)을 소비한다. `preserve`는 생성형 쿼터를 소비하지 않는다. 초과 시 `429 daily_quota_exceeded`이며 임의 재시도하지 않는다.

## 편입 세 방식 — 언제 무엇을 쓰나

| | 원문 보존 (`preserve_*`) | 위임형 정리 (`curate_*`) | 직접 큐레이션 (`create_source`+`write_page`) |
|---|---|---|---|
| 처리 주체 | 결정론 파이프라인 | 앱의 ingest 파이프라인(내부 AI) | 너(외부 에이전트) |
| 얻는 것 | 불변 Source + pointer note | 원문 저장·note·concept/entity 합성·초안 검토 | 문서 구조·분류·상호참조를 네가 설계 |
| 비용 | 생성형 쿼터 없음 | 위키 소유자의 생성 쿼터 | 네 쪽 토큰만 |
| 언제 | "원문만 그대로 보관" | "정리해서 지식으로 저장" | 여러 원문 종합·기존 문서 재구성 |

## 비동기 잡 폴링

ingest 잡은 비동기로 돌며 즉시 `{ runId }`를 반환한다. 완료는 폴링으로 확인한다:

```sh
# status: pending | running | done | error. done이면 output, error면 error.
curl -sH "Authorization: Bearer $KEY" "$JIMI_WIKI_URL/api/wikis/$SLUG/runs/$RUN_ID"
```

MCP에서는 `get_run_status(runId)`가 같은 일을 한다. 워커가 처리하므로 즉시 완료되지 않는다 — 몇 초 간격으로 폴링하라.

> `status: "error"`인데 `published: true`가 붙어 있으면 **콘텐츠는 이미 발행됐고 검색 색인만 미완**이다. 재편입하면 중복이 되므로 재시도하지 말고 사용자에게 그대로 알린다.
