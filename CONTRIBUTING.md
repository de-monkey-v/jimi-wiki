# Contributing · 기여 가이드

Thanks for your interest! · 관심 가져주셔서 감사합니다! 🙌

This document is bilingual — English first, 한국어 아래.

---

## English

### Getting set up

Prerequisites: Node 20+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env          # fill in at least GEMINI_API_KEY
pnpm db:up                    # start Postgres (pgvector) on port 5433
pnpm db:migrate               # apply schema + generate Prisma client
pnpm dev:all                  # web (:3007) + ingest worker together
```

Open http://localhost:3007 and create the first admin at `/setup`. See the [README](README.md)
for the full environment-variable reference and auth modes.

### Before you open a PR

Run the same checks CI runs:

```bash
pnpm lint
pnpm typecheck
pnpm test          # unit tests (pure logic)
pnpm smoke         # requires a running DB (pnpm db:up)
pnpm build         # production build must succeed
pnpm check:rules   # ontology rules ↔ skill parity
```

- **Keep changes small and focused.** One logical change per PR.
- **Match the existing style.** Comments and identifiers in this repo are largely in Korean;
  follow the file you are editing. No formatter churn / unrelated refactors.
- **Add or update tests** when you change parsing, contracts, persistence, or edge cases.
  Pure-logic tests live next to the code as `src/lib/*.test.ts` and run under `pnpm test`.
- **Never commit secrets** or `.env` files. `.gitignore` already covers `.env*`,
  `.openai-oauth.json`, and `local/`.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`.
Examples from history: `feat(ingest): …`, `fix(markdown): …`, `refactor(wiki): …`.
Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.

### Branching

Branch off `dev`, open the PR against `dev`. `main` is the release branch.

### Internationalization (i18n)

UI chrome is localized with [next-intl](https://next-intl.dev) (cookie-based locale, no URL routing).
- **Add a language**: add the code to `src/i18n/locales.ts` (`LOCALES` + `LOCALE_LABELS`), then create
  `messages/<code>.json` mirroring the keys in `messages/ko.json` (the source of truth).
- **Add/translate a string**: use `t("key")` (client: `useTranslations`, async server: `getTranslations`)
  and add the key to **all** locale files. HTML in a message → render with `t.rich`.
- `pnpm check:i18n` enforces that every locale has the same keys (runs in CI). Wiki content itself is not
  translated — only the interface.

### Reporting bugs / requesting features

Use the issue templates. For security issues, **do not** open a public issue — see
[SECURITY.md](SECURITY.md).

### License of contributions

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).

---

## 한국어

### 개발 환경 준비

사전 요구: Node 20+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env          # 최소 GEMINI_API_KEY 채우기
pnpm db:up                    # Postgres(pgvector) 5433 포트로 기동
pnpm db:migrate               # 스키마 적용 + Prisma 클라이언트 생성
pnpm dev:all                  # web(:3007) + ingest worker 동시 기동
```

http://localhost:3007 접속 후 `/setup`에서 첫 관리자를 만드세요. 환경변수 전체와 인증 모드는
[README](README.md)를 참고하세요.

### PR 올리기 전에

CI가 돌리는 검사를 그대로 실행하세요:

```bash
pnpm lint
pnpm typecheck
pnpm test          # 유닛 테스트(순수 로직)
pnpm smoke         # DB 기동 필요 (pnpm db:up)
pnpm build         # 프로덕션 빌드가 성공해야 함
pnpm check:rules   # ontology 규칙 ↔ skill parity
```

- **변경은 작고 focused하게.** PR 하나에 논리적 변경 하나.
- **기존 스타일을 따르세요.** 이 저장소의 주석·식별자는 대체로 한국어입니다. 편집하는 파일의 관례를
  따르고, 포매터 churn·무관한 리팩토링은 넣지 마세요.
- 파싱·계약·영속화·엣지케이스를 바꾸면 **테스트를 추가/갱신**하세요. 순수 로직 테스트는 코드 옆
  `src/lib/*.test.ts`에 두고 `pnpm test`로 돕니다.
- **시크릿·`.env`는 절대 커밋하지 마세요.** `.gitignore`가 `.env*`, `.openai-oauth.json`, `local/`을
  이미 처리합니다.

### 커밋 메시지

[Conventional Commits](https://www.conventionalcommits.org/) 사용: `type(scope): 요약`.
히스토리 예시: `feat(ingest): …`, `fix(markdown): …`, `refactor(wiki): …`.
주요 타입: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.

### 브랜치

`dev`에서 분기하고 PR도 `dev` 대상으로 올리세요. `main`은 릴리스 브랜치입니다.

### 국제화(i18n)

UI 크롬은 [next-intl](https://next-intl.dev)로 번역합니다(쿠키 기반 locale, URL 라우팅 없음).
- **언어 추가**: `src/i18n/locales.ts`의 `LOCALES`·`LOCALE_LABELS`에 코드를 넣고, `messages/ko.json`(기준)의
  키 구조를 그대로 복사해 `messages/<code>.json`을 만드세요.
- **문자열 추가/번역**: `t("key")`로 렌더(클라이언트 `useTranslations`, async 서버 `getTranslations`)하고 **모든**
  로케일 파일에 키를 추가하세요. 메시지에 HTML이 있으면 `t.rich`로 렌더합니다.
- `pnpm check:i18n`이 로케일 간 키 정합성을 강제합니다(CI 포함). 위키 콘텐츠 자체는 번역하지 않고 인터페이스만 번역합니다.

### 버그 신고 / 기능 제안

이슈 템플릿을 사용하세요. 보안 문제는 **공개 이슈로 올리지 말고** [SECURITY.md](SECURITY.md)를 따르세요.

### 기여물 라이선스

기여하면 해당 기여물이 [MIT License](LICENSE) 하에 배포되는 데 동의하는 것으로 간주합니다.
