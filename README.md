# jimi-wiki-app

**한국어** | [English](README.en.md)

LLM이 유지보수자 역할을 맡는 협업 위키 플랫폼. 소스를 편입(ingest)하면 앱 내부 AI가 소스 노트·개념/개체 페이지·상호참조를 만들고, 하이브리드 검색(BM25 + 임베딩)과 그래프로 지식을 탐색한다. 외부 에이전트(Claude Code 등)는 REST/MCP로 같은 위키를 직접 유지보수할 수 있다.

![jimi-wiki 위키 목록 셸 화면](docs/assets/shell-wikis.png)

## 스택

- **Next.js 16** (App Router, React 19) — 웹 UI + `/api/*` 라우트
- **PostgreSQL 17 + pgvector** — 데이터 + 임베딩 벡터 검색 (docker compose)
- **Prisma 7** — ORM, 생성 클라이언트는 `src/generated/prisma`
- **Auth.js (next-auth v5)** — 로컬 이메일+비밀번호(argon2id) 인증. self-host 지향, 외부 OAuth 불필요 (`AUTH_MODE` 참조)
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

# 5. 개발 서버 (포트 3007)
pnpm dev

# 6. 별도 터미널에서 ingest worker
pnpm worker
```

http://localhost:3007 접속 → **최초 접속 시 `/setup`에서 첫 관리자 계정을 만든다**(아래 인증 참조). 원격/다른 호스트에서 접속하려면 `next.config`의 `allowedDevOrigins`를 확인한다.

### 인증 · 계정 (`AUTH_MODE`)

외부 OAuth 없이 앱이 직접 계정을 관리한다. `.env`의 `AUTH_MODE`로 고른다:

| 모드 | 로그인 | 대상 | 계정 관리 |
|---|---|---|---|
| `single` | 없음 | 나 혼자 (localhost 전용 권장) | 암묵적 owner 1명 |
| `local` (기본) | 이메일+비밀번호(argon2id) | 소팀 내부 서버 | 관리자 생성 / 초대 링크 |
| `oidc` | 외부 OIDC | 사내 IdP 보유 | *phase-2 (미배선)* |

**first-run 관리자 만들기 (`local`):** 둘 중 하나.
- **웹**: 첫 접속 시 `/setup`에서 관리자 이메일·비밀번호 입력. (유저가 생기면 자동 잠김)
- **헤드리스**: `.env`에 `ADMIN_EMAIL`/`ADMIN_PASSWORD`를 채우고 `pnpm db:seed`.

이후 관리자는 **`/admin/users`**에서 유저를 직접 생성하거나 **초대 링크**(`/invite/<token>`)를 발급한다. **공개 회원가입은 없다** — 초대받은 사람만 계정을 만들 수 있다.

> **네트워크로 접속한다면** 비밀번호가 오가므로 `single`(로그인 없음)은 피하고 `local`을 쓴다. 집 밖에서도 붙는다면 **Tailscale**(사설 VPN, 포트 노출 없이 안전) 또는 리버스 프록시(Caddy/Cloudflare Tunnel)로 HTTPS를 앞에 둔다.

### 주요 환경변수 (`.env.example` 참조)

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | Postgres 접속 (docker compose 기본값: `postgresql://jimi:jimi@localhost:5433/jimi`) |
| `AUTH_SECRET` | 세션/JWT 서명 키 (`openssl rand -base64 32`) |
| `AUTH_MODE` | 인증 모드: `single` \| `local`(기본) \| `oidc` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | (선택) `pnpm db:seed` 시 first-run 관리자 부트스트랩. 웹 `/setup`을 쓰면 비워둠 |
| `APP_URL` | 앱 공개 URL — 초대/공유 링크 절대경로 조립용 |
| `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini 생성 + 임베딩 키 (동일 값) |
| `ANTHROPIC_API_KEY` | (선택) 모델을 `claude-*`로 쓸 때 필요 |
| `OPENAI_API_KEY` | (선택) 모델을 `gpt-*`/`o*`로 쓸 때 필요 (chat·ingest·lint) |
| `OPENAI_BASE_URL` | (선택·개인 로컬 전용) OpenAI 호환 프록시 주소. 외부 codex-auth 프록시를 직접 띄워 태울 때만. ⚠️ 공개 배포 금지 |
| `OPENAI_OAUTH_PERSONAL` | (선택·개인 로컬 전용) `1`이면 `pnpm openai:login`으로 로그인한 ChatGPT 구독 OAuth를 앱에서 직접 사용(별도 프록시 불필요). `OPENAI_BASE_URL`이 있으면 그쪽 우선. ⚠️ 개인 self-host 전용, 여러 사람에게 서비스로 열지 말 것(약관). 자세한 사용법은 [`docs/openai-oauth.md`](docs/openai-oauth.md) |
| `EMBED_MODEL` / `EMBED_DIM` | 임베딩 모델·차원 (기본 `gemini-embedding-001` / `768`, Gemini 전용). ⚠️ 차원 변경은 DB 마이그레이션+재색인 필요 |
| `INGEST_MODEL` / `GEN_MODEL` / `CHAT_MODEL` | ingest / query·lint / 채팅 모델. `gemini-*` \| `claude-*` \| `gpt-*` 혼용 가능 (기본 Gemini) |
| `DAILY_TOKEN_LIMIT` | 유저별 일일 생성형 토큰 상한 |
| `WORKER_POLL_MS` | ingest worker 폴링 주기 |

### API 키 격리 · 비용 안전 ⚠️

앱은 `process.env`에서 키를 읽는다. **표준(Next.js·dotenv) 우선순위상 셸에 export된 환경변수가 `.env`보다 우선한다** — 즉 `.zshrc` 등에 개인 `OPENAI_API_KEY`가 export돼 있으면, `.env`에 뭘 넣든(혹은 비워도) 그 **셸 키로 과금**된다. 무심코 개인 키가 쓰이는 것을 막으려면:

- **Docker (가장 확실)**: `docker compose`는 `env_file: .env`로만 키를 읽고 **컨테이너는 호스트 셸 env를 상속하지 않는다** → `.env`만 사용, 완전 격리. 비용이 걱정되면 Docker로 돌리는 것이 답이다.
- **로컬(비-Docker)**: API 키를 **셸에 export하지 말고 프로젝트 `.env`에만** 둔다. 현재 셸 상태 확인: `env | grep -E 'OPENAI|GEMINI|ANTHROPIC|_API_KEY'` — 여기 뜬 키가 앱에 쓰인다. (디렉터리별 격리가 필요하면 [`direnv`](https://direnv.net) 사용 권장)
- **`override: true`로 `.env`가 셸을 이기게 하는 것은 비권장** — dotenv를 쓰는 worker/스크립트에만 적용되고 Next 웹 서버는 자체 로더라, 웹은 셸 키·워커는 `.env` 키로 **갈려 서로 다른 키를 쓰는** 더 위험한 상태가 된다.
- **전용 API 키 권장**: 이 앱 전용으로 별도 발급한 키를 쓰면(다른 도구와 공유 X) 사용량·비용을 독립 추적하고 필요 시 이 키만 폐기할 수 있다. provider 콘솔에서 **사용량 상한(budget)** 을 걸어두면 이중 안전장치가 된다.

`worker`는 시작 시 **활성 provider 키와 그 출처(`.env` vs 셸/환경 ⚠️)** 를 로그로 찍어, 어떤 키로 과금되는지 바로 확인할 수 있다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm dev` | 개발 서버 (포트 3007) |
| `pnpm dev:all` | web + worker 한 번에 기동(로그 합침, Ctrl-C로 둘 다 종료) |
| `pnpm start:all` | 프로덕션 web(`start`) + worker 한 번에 기동 |
| `pnpm worker` | pending ingest 잡 처리 worker |
| `pnpm build` / `pnpm start` | 프로덕션 빌드 / 서버 |
| `pnpm db:up` | Postgres 컨테이너 기동 |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:seed` | first-run 관리자 부트스트랩 (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) |
| `pnpm apikey:issue` | CLI로 API 키 발급 |
| `pnpm openai:login` | (개인용) ChatGPT 구독 OAuth 로그인 — `OPENAI_OAUTH_PERSONAL=1`과 함께 사용 |
| `pnpm smoke` | 스모크 테스트 |
| `pnpm check:rules` | ontology rules ↔ skill parity 검사 |
| `pnpm mcp` | MCP 서버 실행 (`mcp/server.mjs`) |

## 운영 배포 메모

self-host를 전제로 한다 — 내부 서버(또는 자체 호스트)에 올리고 `AUTH_MODE=local`로 계정을 직접 관리한다. 프로세스는 셋으로 나눈다(같은 repo).

- `web`: `pnpm build` 후 `pnpm start`
- `worker`: `pnpm worker`
- `postgres`: `pgvector/pgvector:pg17`

`web`·`worker`는 같은 `DATABASE_URL`, `AUTH_SECRET`, `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `AUTH_MODE`를 공유한다. 첫 배포 시 `ADMIN_EMAIL`/`ADMIN_PASSWORD`로 관리자를 부트스트랩하거나 `web`의 `/setup`에서 만든다. 인터넷에 노출한다면 리버스 프록시로 HTTPS를 두거나 Tailscale 같은 사설 네트워크 뒤에 둔다.

**Docker 로 한 번에**: `docker compose up --build` 하면 `db`·`web`(3007)·`worker`가 함께 뜬다. `web`·`worker`는 같은 이미지(command 로 역할 구분)이고, `.env`를 `env_file`로 읽되 `DATABASE_URL`은 컨테이너용(`db:5432`)으로 덮어쓴다. ChatGPT OAuth 토큰은 `jimi-oauth` 볼륨(`/data`)에 두어 web·worker가 공유한다. 개발 중이면 `pnpm dev:all`(web+worker 동시)로 충분하다.

**모델 선택 · ChatGPT 로그인**: 관리자는 **`/admin/settings`**에서 채팅·ingest·query/lint 모델을 provider별 목록에서 골라 저장하고(재시작 없이 반영), ChatGPT 구독 OAuth를 브라우저 없이 device-code 로 로그인/로그아웃할 수 있다. env(`CHAT_MODEL` 등)는 미설정 시 폴백. 자세한 OAuth 흐름은 [`docs/openai-oauth.md`](docs/openai-oauth.md).

Health check:

- `/api/healthz`: 프로세스 생존 확인
- `/api/readyz`: DB 연결과 필수 환경변수 확인

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

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고한다. 보안 문제는 공개 이슈로 올리지 말고 [SECURITY.md](SECURITY.md)를 따른다.

## 라이선스

**MIT** — 전문은 [`LICENSE`](LICENSE). 사용·수정·재배포·상업적 이용 모두 자유롭게 허용된다. 저작권·라이선스 고지만 유지하면 된다.
