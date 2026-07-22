# ChatGPT 구독으로 GPT 모델 쓰기 (개인용 OAuth)

opencode / openclaw 처럼, **OpenAI API 크레딧을 사지 않고 개인 ChatGPT Plus/Pro 구독**으로 이 앱의
GPT 모델(채팅·ingest·lint)을 구동하는 방법이다. 앱 안에서 한 번 로그인하면 토큰이 로컬에 저장되고
자동 갱신된다 — 별도 프록시를 띄울 필요가 없다.

> ⚠️ **개인 self-host 전용.** 개인 ChatGPT 구독을 *나 혼자* 쓰기 위한 것이다. 여러 사람에게 서비스로
> 열면(= 한 계정으로 다수 사용자 요청을 태우면) ChatGPT 약관 위반이다. 자세한 경계는 아래 [범위](#범위와-주의) 참조.

---

## 동작 원리 (요약)

1. `pnpm openai:login` 이 브라우저를 열어 `auth.openai.com` 에서 OAuth 2.0 **PKCE** 로그인을 한다.
2. `localhost:1455` 콜백으로 authorization code 를 받아 access/refresh 토큰으로 교환한다.
3. 토큰은 `.openai-oauth.json`(gitignore, 권한 0600)에 저장된다.
4. 앱은 GPT 모델 호출 시 표준 `api.openai.com` 이 아니라 **ChatGPT 백엔드**
   (`https://chatgpt.com/backend-api/codex`)로 보내고, 매 요청 토큰을 갱신해 헤더
   (`Authorization`, `chatgpt-account-id`, `originator: codex_cli_rs`, `session_id`)에 실는다.
   codex 백엔드는 **스트리밍(stream:true)만 허용**하므로, 툴콜 루프(ingest·lint·query)도 내부적으로
   streamText 로 돌린다. `store:false` 는 자동 강제된다.

즉 구독에 묶인 rate limit 으로 `gpt-5.x` 를 쓴다. (원리·코드 위치는 opencode
`packages/core/src/plugin/provider/openai.ts` 와 동일 패턴.)

---

## 사용법

### 1. 로그인

```bash
pnpm openai:login
```

- 브라우저가 자동으로 열린다. (WSL 이면 Windows 기본 브라우저가 열린다.)
- 자동으로 안 열리면 **콘솔에 출력된 URL 을 브라우저에 직접 붙여넣는다.**
  콜백은 `localhost:1455` 이므로, WSL 에서 Windows 브라우저로 접속해도 로컬포트 포워딩으로 도달한다.
- ChatGPT 계정으로 로그인하면 "로그인 완료" 페이지가 뜨고 터미널에 저장 결과가 찍힌다.

### 2. 환경변수 켜기

`.env` 에 추가:

```bash
OPENAI_OAUTH_PERSONAL=1        # OAuth 경로 활성화
CHAT_MODEL=gpt-5.6-sol         # ChatGPT 구독에서 쓸 수 있는 모델 (GEN_MODEL / INGEST_MODEL 도 지정 가능)
```

> - `OPENAI_BASE_URL` 이 설정돼 있으면 **그쪽(외부 프록시)이 우선**한다. OAuth 경로를 쓰려면 비워둔다.
> - **모델 이름**은 네 ChatGPT 플랜이 노출하는 것을 써야 한다(예: `gpt-5.6-sol`). `gpt-5.1`·`*-codex` 처럼
>   플랜에 없는 id 는 codex 백엔드가 `model is not supported ...` 로 거부한다. 거부되면 다른 id 로 바꿔본다.

### 3. 검증 (실제 호출 테스트)

```bash
pnpm openai:smoke              # 또는: pnpm openai:smoke gpt-5.6-sol
```

OAuth 경로로 GPT 에 한 문장 질의를 보내 응답·토큰 usage 를 출력한다. 성공하면 배선이 완료된 것이다.

### 4. 앱에서 사용

```bash
pnpm dev
```

채팅(`CHAT_MODEL`)·ingest(`INGEST_MODEL`)·lint/query(`GEN_MODEL`)가 지정한 GPT 모델을 쓴다.
web 과 worker 는 같은 토큰 파일을 공유하므로 둘 다 자동으로 적용된다.

---

## 토큰 관리

| 항목 | 내용 |
|---|---|
| 저장 위치 | `.openai-oauth.json` (또는 `OPENAI_OAUTH_STORE` 로 경로 지정) |
| 권한 | `0600` (소유자만 읽기/쓰기) |
| 자동 갱신 | 만료 60초 전 refresh. 앱이 알아서 처리 |
| 재로그인 | 토큰이 깨지거나 `refresh token 없음` 에러 시 `pnpm openai:login` 다시 실행 |
| 로그아웃 | `.openai-oauth.json` 삭제 |

**절대 커밋/공유 금지** — 이 파일에는 계정 refresh 토큰이 들어있다. `.gitignore` 에 등록돼 있다.

---

## 범위와 주의

이 기능은 **1인 = 1계정** 개인용이다.

- ✅ 본인이 여러 기기에서 자기 서버의 앱에 접속해 개인 비서로 쓰는 것 — 정상 사용.
- ⚠️ 다른 사람들이 당신 서버를 통해 프롬프트를 날리는 것(당신 구독으로 다수 사용자 서비스) — 약관 회색지대.
  이 경우엔 각 사용자가 자기 계정으로 로그인하는 별도 구조가 필요하다.
- 🔒 `OPENAI_OAUTH_PERSONAL` 은 명시적 opt-in 스위치다. 공개 배포 인스턴스에서는 켜지 말 것.
- `originator` 값 등 일부 파라미터는 OpenAI Codex 공개 client 에 묶인 값을 재사용한다.
  OpenAI 정책이 바뀌면 이 경로가 막힐 수 있다(과거 Anthropic 이 서드파티 OAuth 를 차단한 전례 있음).
  그때는 표준 `OPENAI_API_KEY` 경로로 폴백하면 된다.

---

## 문제 해결

| 증상 | 원인·조치 |
|---|---|
| `openai:smoke` 가 "OAuth 경로 비활성" | `OPENAI_OAUTH_PERSONAL=1` 미설정, 토큰 없음, 또는 `OPENAI_BASE_URL` 이 설정됨 |
| 401 / 403 | 토큰 만료·무효 → `pnpm openai:login` 재실행 |
| `model ... is not supported` | 플랜에 없는 모델 id → `gpt-5.5` 등 네 ChatGPT 플랜이 노출하는 id 로 변경 |
| `Stream must be set to true` | codex 는 스트리밍 전용. 앱은 이미 streamText 로 처리하므로 정상 경로에선 안 뜬다(직접 `generateText` 호출 시 발생) |
| 그 외 400 / 422 | 요청 포맷 문제 → `src/lib/openai.ts` 의 `codexFetch` 바디 정규화 확장 필요 |
| 브라우저가 안 열림 | 콘솔 URL 을 직접 복사해 브라우저에 붙여넣기 (콜백은 `localhost:1455`) |
| `EADDRINUSE :1455` | 1455 포트를 다른 프로세스가 점유 중 → 해당 프로세스 종료 후 재시도 |
