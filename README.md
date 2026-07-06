# jimi-wiki-app

LLM이 유지보수자 역할을 맡는 협업 위키 플랫폼. 소스를 편입(ingest)하면 앱 내부 AI가 소스 노트·개념/개체 페이지·상호참조를 만들고, 하이브리드 검색(BM25 + 임베딩)과 그래프로 지식을 탐색한다. 외부 에이전트(Claude Code 등)는 REST/MCP로 같은 위키를 직접 유지보수할 수 있다.

## 스택

- **Next.js 16** (App Router, React 19) — 웹 UI + `/api/*` 라우트
- **PostgreSQL 17 + pgvector** — 데이터 + 임베딩 벡터 검색 (docker compose)
- **Prisma 7** — ORM, 생성 클라이언트는 `src/generated/prisma`
- **Auth.js (next-auth v5)** — 세션 인증. 개발 중에는 시드된 dev 계정을 사용
- **Gemini** (`@ai-sdk/google` / `@google/genai`) — 생성 + 임베딩. (선택) Anthropic 모델로 ingest 오버라이드 가능
- **pnpm** — 패키지 매니저

## 시작하기

사전 요구: Node 20+, pnpm, Docker.

```bash
# 1. 의존성
pnpm install

# 2. 환경변수 — .env.example을 복사해 값 채우기 (최소 GEMINI_API_KEY)
cp .env.example .env

# 3. Postgres(pgvector) 기동 — 컨테이너 jimi-wiki-db, 로컬 포트 5433
pnpm db:up

# 4. 스키마 마이그레이션 적용
pnpm db:migrate

# 5. 개발용 dev 계정 시드 (DEV_USER_EMAIL 기준)
pnpm db:seed

# 6. 개발 서버 (포트 3007)
pnpm dev
```

http://localhost:3007 접속. 원격/다른 호스트에서 접속하려면 `next.config`의 `allowedDevOrigins`를 확인한다.

### 주요 환경변수 (`.env.example` 참조)

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | Postgres 접속 (docker compose 기본값: `postgresql://jimi:jimi@localhost:5433/jimi`) |
| `AUTH_SECRET` | 세션 서명 키 (`openssl rand -base64 32`) |
| `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | 생성 + 임베딩 (동일 값) |
| `DEV_USER_EMAIL` | OAuth 붙이기 전 임시 세션 계정 |
| `ANTHROPIC_API_KEY`, `INGEST_MODEL` | (선택) ingest 모델을 `claude-*`로 오버라이드할 때 |

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm dev` | 개발 서버 (포트 3007) |
| `pnpm build` / `pnpm start` | 프로덕션 빌드 / 서버 |
| `pnpm db:up` | Postgres 컨테이너 기동 |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:seed` | dev 계정 시드 |
| `pnpm apikey:issue` | CLI로 API 키 발급 |
| `pnpm smoke` | 스모크 테스트 |
| `pnpm mcp` | MCP 서버 실행 (`mcp/server.mjs`) |

## 프로그램적 접근 (REST / MCP)

외부 에이전트가 앱 내부 AI 없이 위키를 유지보수할 수 있다. **웹 UI는 세션(쿠키)으로, 프로그램 호출은 API 키(Bearer)로 인증**한다.

1. **API 키 발급**: 로그인 후 `/keys`에서 발급. 위키 스코프·상한 역할(읽기전용/편집)·만료를 지정할 수 있다. 발급 시 원문 키는 한 번만 노출된다.
2. **REST**: `Authorization: Bearer <KEY>` 헤더로 `/api/wikis/{slug}/*` 호출. 전체 레퍼런스는 [`docs/rest-api.md`](docs/rest-api.md).
3. **MCP**: `mcp/server.mjs`를 MCP 클라이언트(Claude Code 등)에 등록하면 콘텐츠 API가 도구로 노출된다. 세부 워크플로우는 [`skills/wiki-ingest/SKILL.md`](skills/wiki-ingest/SKILL.md).

   ```bash
   claude mcp add jimi-wiki \
     -e JIMI_WIKI_URL=http://localhost:3007 \
     -e JIMI_WIKI_API_KEY=<키> \
     -e JIMI_WIKI_SLUG=<위키슬러그> \
     -- node <repo>/mcp/server.mjs
   ```

> 내부 AI를 소비하는 라우트(`/ingest`, `/query`, `/reindex`, `/lint?deep`)는 **세션 전용**이다. API 키로는 `create_source` + `write_page` 같은 primitive로 위키를 직접 작성하고, 앱 내부 AI ingest는 웹 UI에서 실행한다. 자세한 정책은 `docs/rest-api.md` 참조.

## 라이선스

**Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)** — 전문은 [`LICENSE.md`](LICENSE.md).

내부 사용, 수정, 비상업적 교육·연구, 자체 배포는 자유롭게 허용된다. 다만 이 소프트웨어를 대체하거나 실질적으로 동일한 기능을 제공하는 **상업적 제품·서비스(예: 경쟁 SaaS 호스팅)로 제공하는 것은 금지**된다. 각 버전은 공개 후 **2년이 지나면 Apache License 2.0으로 자동 전환**된다.
