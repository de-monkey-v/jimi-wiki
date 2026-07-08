# Security Policy · 보안 정책

## Reporting a vulnerability · 취약점 신고

**English** — Please do **not** open a public issue for security vulnerabilities.
Instead, report privately via [GitHub Security Advisories](https://github.com/gyuhyeonLee/jimi-wiki-app/security/advisories/new)
(**Security → Report a vulnerability** on the repo). If that is unavailable, email the maintainer.
Include: affected version/commit, reproduction steps, impact, and any PoC. We aim to acknowledge
within **72 hours** and to ship a fix or mitigation for confirmed issues as fast as is practical.

**한국어** — 보안 취약점은 **공개 이슈로 올리지 말아 주세요.**
[GitHub Security Advisories](https://github.com/gyuhyeonLee/jimi-wiki-app/security/advisories/new)
(리포지토리의 **Security → Report a vulnerability**)로 비공개 신고해 주세요. 불가하면 관리자 이메일로 알려 주세요.
영향받는 버전/커밋, 재현 절차, 영향 범위, 가능하면 PoC를 포함해 주세요. **72시간 내** 확인 회신을 목표로 하며,
확인된 문제는 가능한 한 빠르게 수정/완화 배포합니다.

## Supported versions · 지원 범위

This is a self-hosted application; there is no hosted service to patch centrally. Security fixes land on
`main`. Run the latest `main` (or the latest tagged release) to stay current.

self-host 애플리케이션이라 중앙에서 패치할 호스팅 서비스가 없습니다. 보안 수정은 `main`에 반영됩니다.
최신 `main`(또는 최신 릴리스 태그)을 사용해 주세요.

## Deployment hardening · 배포 시 주의

- **Never expose the raw dev server to the public internet without HTTPS.** Put a reverse proxy
  (Caddy / Cloudflare Tunnel) or a private network (Tailscale) in front. `AUTH_MODE=single` (no login)
  is for `localhost` only.
- Keep secrets (`AUTH_SECRET`, `GEMINI_API_KEY`, `DATABASE_URL`, `.openai-oauth.json`) out of git —
  they are already covered by `.gitignore`. Rotate `AUTH_SECRET` if it ever leaks.
- API keys are shown once at issue time and stored hashed. Scope them (read-only vs edit) and set expiry.

- **HTTPS 없이 dev 서버를 인터넷에 직접 노출하지 마세요.** 리버스 프록시(Caddy / Cloudflare Tunnel)나
  사설망(Tailscale) 뒤에 두세요. `AUTH_MODE=single`(로그인 없음)은 `localhost` 전용입니다.
- 시크릿(`AUTH_SECRET`, `GEMINI_API_KEY`, `DATABASE_URL`, `.openai-oauth.json`)은 git에 올리지 마세요
  (이미 `.gitignore` 처리됨). 유출 시 `AUTH_SECRET`을 교체하세요.
- API 키는 발급 시 한 번만 노출되고 해시로 저장됩니다. 스코프(읽기전용/편집)와 만료를 지정하세요.
