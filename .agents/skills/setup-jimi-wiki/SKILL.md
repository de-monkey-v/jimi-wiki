---
name: setup-jimi-wiki
description: Install, configure, diagnose, and verify a cloned jimi-wiki checkout for local use, including Docker PostgreSQL, NVIDIA TEI local embeddings, Prisma generation and migrations, first-admin startup, and personal ChatGPT/Codex OAuth. Use when the user asks to install, set up, first-run, or troubleshoot jimi-wiki, configure KURE/bge local embeddings, or connect personal Codex OAuth. Do not use for production release operations or ordinary feature development.
---

# Set up Jimi Wiki

Set up a local development instance from the repository root. Keep production
release operations in `docs/personal-production.md` out of this workflow.

## Establish the requested profile

Confirm only choices that cannot be inferred safely:

- Use `local` embeddings when the user asks for KURE, bge-m3, or an offline
  embedding model. This path requires x86_64 Linux/WSL, an NVIDIA GPU, and a
  Docker NVIDIA runtime.
- Use `external` only when the user already has a TEI-compatible endpoint.
- Use `gemini` only when the user explicitly accepts external embeddings and
  supplies their own API key.
- Treat ChatGPT/Codex OAuth as single-person self-hosting. Never configure one
  person's subscription as a shared multi-user service.

Do not silently fall back from local embeddings to a paid provider.

## Run the safe preflight

From the repository root, run:

```bash
node scripts/setup-local.mjs check --embedding local
```

Use `--embedding external` or `--embedding gemini` only for the corresponding
profile. Stop on every `FAIL`. Explain the missing prerequisite instead of
installing system packages, enabling GPU runtimes, changing access controls, or
using `sudo` without explicit user authorization.

The preflight output is sanitized. Do not print `.env`,
`.openai-oauth.json`, `~/.codex/auth.json`, shell API keys, or Docker
environment values while diagnosing setup.

## Prepare configuration

If `.env` does not exist, prepare the selected profile with fresh secrets.
For bundled KURE:

```bash
node scripts/setup-local.mjs prepare --oauth --embed-model nlpai-lab/KURE-v1
```

Use `BAAI/bge-m3` when the user prefers multilingual balance. Omit `--oauth`
when the user will use API keys instead.

For an existing TEI endpoint, record both its root URL and the exact model
reported by `/info`:

```bash
node scripts/setup-local.mjs prepare --embedding external \
  --embed-url https://tei.example.test --embed-model nlpai-lab/KURE-v1 --oauth
```

For Gemini embeddings:

```bash
node scripts/setup-local.mjs prepare --embedding gemini --oauth
```

Then ask the user to place their own `GEMINI_API_KEY` into `.env`. Never accept
an API key in a command-line argument, repeat it in chat, or print the resulting
file.

If `.env` already exists, never run `prepare`: it intentionally refuses to
overwrite the file. Use the sanitized `check` result, `.env.example`, and the
environment-variable table in `README.md` to identify required manual changes.
Never replace an existing database password without checking whether the
development volume already contains data created with it.

## Install and initialize

Run each step separately and surface the first failure:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm exec prisma generate
corepack pnpm db:up:embedding
corepack pnpm db:migrate
```

For external or Gemini embeddings, start only the database with
`corepack pnpm db:up`.

Wait for the local embedding server rather than assuming image download means
readiness:

```bash
docker compose --profile embedding ps
curl --fail --silent --show-error http://127.0.0.1:8081/health
```

Do not run `docker compose down -v`, Docker prune commands, or delete/replace
volumes as part of installation.

## Start the application

Start web and worker together:

```bash
corepack pnpm dev:all
```

Keep the process attached or use a process manager already available in the
current Codex surface. Do not invent an unmanaged background process. Ask the
user to open `http://localhost:3006/setup` and create the first local admin.

## Connect personal OAuth

Prefer the admin UI device-code flow at `/admin/settings` after the first admin
exists. If the user prefers the terminal flow, run:

```bash
corepack pnpm openai:login
```

Pause for the user to complete login with their own ChatGPT account. Never
reuse, copy, or inspect another machine's token store.

The setup helper may parse the project-local store only to validate its required
fields and permissions. It never prints or exports token values.

`corepack pnpm openai:smoke` makes a real model request and consumes subscription
quota. Run it only after telling the user and receiving confirmation. Use
`docs/openai-oauth.md` for provider-specific troubleshooting.

## Verify completion

After web, worker, database, and embeddings are running, run:

```bash
node scripts/setup-local.mjs verify --require-app --require-oauth
```

Add `--embedding external` or `--embedding gemini` when that profile was
selected. Omit `--require-oauth` for API-key-only installations. Do not claim
completion unless:

- PostgreSQL is healthy and migrations are present.
- Prisma client generation is present.
- The configured TEI endpoint is healthy and serves the configured model.
- `/api/readyz` succeeds when `--require-app` is requested.
- The personal OAuth store exists with owner-only permissions when OAuth is
  required.

Report the selected embedding model, local URLs, successful checks, and any
manual step remaining. Never include credentials or token contents.
