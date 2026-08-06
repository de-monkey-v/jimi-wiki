# 연결 · 배치 — 하네스별 셋업

이 스킬은 특정 에이전트에 묶이지 않는다. 필요한 것은 두 가지뿐이다: **(A) 위키에 닿는 접근권**(MCP 또는 REST), **(B) 스킬 파일을 에이전트가 읽게 두기**.

## A. 접근권

### 1) API 키 발급 (공통)

모든 외부 호출은 `Authorization: Bearer <키>`로 인증한다.

- 앱의 **API 키** 화면(`/keys`)에서 발급. **쓰기 작업은 editor 이상** 역할이 필요하다.
- 키를 특정 위키로 **스코프**하거나 **상한 역할(maxRole)**·**만료일**을 걸 수 있다. 유효 역할 = `min(멤버십 역할, maxRole)`.
- 원문 키는 발급 시 **한 번만** 표시된다(서버는 sha256 해시만 저장). 안전하게 보관.
- 계정당 활성 키 최대 20개. 레이트리밋: 분당 120 / 시간당 3000회(초과 시 `429` + `Retry-After`).

### 2-a) MCP로 연결 (권장 — MCP 지원 하네스)

저장소의 `mcp/server.mjs`를 MCP 클라이언트에 등록한다.

**Claude Code:**
```sh
claude mcp add --scope local jimi-wiki \
  -e JIMI_WIKI_URL=<앱주소> \
  -e JIMI_WIKI_API_KEY=<발급받은-키> \
  -e JIMI_WIKI_SLUG=<대상-위키-slug> \
  -- node <repo>/mcp/server.mjs
```

**일반 MCP 설정(JSON)** — Codex 등 `mcpServers` 스키마를 쓰는 클라이언트:
```json
{
  "mcpServers": {
    "jimi-wiki": {
      "command": "node",
      "args": ["<repo>/mcp/server.mjs"],
      "env": {
        "JIMI_WIKI_URL": "<앱주소>",
        "JIMI_WIKI_API_KEY": "<발급받은-키>",
        "JIMI_WIKI_SLUG": "<대상-위키-slug>"
      }
    }
  }
}
```

**Hermes Agent** — 위키마다 전용 프로필(`wiki-<slug>`, 예: `wiki-personal`, `wiki-work`)을 두고, 위키 전용 키를 `wiki scope + maxRole=editor + 90일 만료`로 발급해 해당 프로필의 `~/.hermes/profiles/wiki-<slug>/.env`에 `JIMI_WIKI_<SLUG>_KEY=...`로 보관한다(발급은 `pnpm apikey:issue-hermes -- --wiki <slug> --confirm ROTATE_HERMES_<SLUG>_KEY`, 키 이름은 `hermes-<slug>`로 저장되고 같은 이름만 rotate된다). 프로필 `config.yaml`에는 원문 키 대신 placeholder를 쓰고, production에서는 release의 `mcp/server.mjs` 절대 경로를 가리킨다:
```yaml
mcp_servers:
  jimi-wiki:
    command: "node"
    args: ["<repo>/mcp/server.mjs"]
    env:
      JIMI_WIKI_URL: "<앱주소>"
      JIMI_WIKI_API_KEY: "${JIMI_WIKI_<SLUG>_KEY}"
      JIMI_WIKI_SLUG: "<대상-위키-slug>"
    tools:
      # 비서 프로필 — 찾고·넣고·담아두는 일상 사용
      include: [search_wiki, search_documents, read_page, list_pages, list_sources, read_source, create_source, write_page, get_ontology, match_category, get_capture_context, preserve_url, preserve_text, curate_url, curate_text, curate_source, get_run_status, record_document, record_research_report, record_worklog, append_document, save_link, list_saved_links, promote_saved_link, trash_saved_link, restore_saved_link, list_trash, trash_page, restore_page, trash_source, restore_source]
```

- **개인 위키 프로필**(위 `include`): 검색·원문 보존·직접/위임 정리·문서 기록·읽을거리 관리를 허용한다. 보호 메모(`personal/internalOnly`)는 MCP에서 보이지 않는다.
- Hermes의 일반 문서 저장은 `get_capture_context → record_document` 순서로 두고, 정기 cron은 날짜/대상별 안정적인 `idempotencyKey`를 보낸다. 폴더 정책 전문을 SOUL/job prompt에 복사하지 않는다.
- **유지보수 프로필**: `include`를 지우면 `run_lint`를 포함한 전체 비파괴 도구가 추가로 노출된다.
- 휴지통 도구는 14일 복구 가능하므로 개인 프로필에도 노출한다. 영구 purge와 위키 전체 삭제 도구는 MCP 서버 자체에 없다.
- Claude Code 프로젝트 위키는 프로젝트 전용 키와 slug로 위 명령을 `--scope local` 등록한다. 그 키로 개인/다른 프로젝트 위키를 요청하면 `404`가 정상이다.

### 2-b) REST로 연결 (MCP 없는 하네스)

MCP를 못 쓰는 환경은 bash+curl로 REST를 직접 호출한다. 능력↔엔드포인트 매핑은 [`tools.md`](./tools.md), 전체 레퍼런스는 저장소의 `docs/rest-api.md`.

```sh
export JIMI_WIKI_URL="<앱주소>"
export KEY="jw_..."
export SLUG="<대상-위키-slug>"
export BASE="$JIMI_WIKI_URL/api/wikis/$SLUG"
curl -sH "Authorization: Bearer $KEY" "$BASE/pages"   # 연결 확인
```

## B. 스킬 파일 배치 (하네스별)

스킬 본체는 `SKILL.md` + `references/`다. 폴더째로 옮겨야 참조(ontology-rules·tools·setup)가 유지된다.

- **Claude Code** — 이 폴더를 `.claude/skills/wiki-ingest/`(프로젝트) 또는 `~/.claude/skills/wiki-ingest/`(전역)에 둔다. frontmatter의 `name`/`description`으로 자동 발견되고 `/wiki-ingest`로 호출된다.
- **Hermes Agent** — 기본 프로필은 `~/.hermes/skills/wiki-ingest/`, 위키 프로필은 `~/.hermes/profiles/wiki-<slug>/skills/wiki-ingest/`(예: `wiki-personal`)에 복사한다. Hermes는 `SKILL.md` 형식을 그대로 읽는다. 위임형 편입만 쓸 거라면 스킬 없이 MCP 도구 설명만으로도 동작한다 — 직접 큐레이션을 시킬 때 스킬이 필요하다.
- **Codex 등 invoke 도구 없는 하네스** — invoke 개념이 없다. 에이전트에게 `SKILL.md` 경로를 알려주고 "이 SKILL.md를 읽고 그 워크플로우를 따르라"고 지시하면 된다. frontmatter는 무시돼도 무방하다.
- **그 외** — SKILL.md는 순수 마크다운 지침이다. 어떤 에이전트든 이 파일과 `references/`를 읽을 수 있으면 사용 가능하다.

> 어느 하네스든 **워크플로우는 동일**하다. 달라지는 건 (a) 파일을 어디 두는지, (b) 도구를 MCP로 부르는지 REST로 부르는지뿐이다.
