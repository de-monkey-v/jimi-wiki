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
claude mcp add jimi-wiki \
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
- **Codex 등 invoke 도구 없는 하네스** — invoke 개념이 없다. 에이전트에게 `SKILL.md` 경로를 알려주고 "이 SKILL.md를 읽고 그 워크플로우를 따르라"고 지시하면 된다. frontmatter는 무시돼도 무방하다.
- **그 외** — SKILL.md는 순수 마크다운 지침이다. 어떤 에이전트든 이 파일과 `references/`를 읽을 수 있으면 사용 가능하다.

> 어느 하네스든 **워크플로우는 동일**하다. 달라지는 건 (a) 파일을 어디 두는지, (b) 도구를 MCP로 부르는지 REST로 부르는지뿐이다.
