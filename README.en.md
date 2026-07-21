# jimi-wiki-app

[한국어](README.md) | **English**

A collaborative wiki platform where an LLM plays the role of maintainer. When you **ingest** a source,
the app's built-in AI creates source notes, concept/entity pages, and cross-references; you explore the
knowledge with hybrid search (BM25 + embeddings) and a graph. External agents (Claude Code, etc.) can
maintain the same wiki directly over REST/MCP.

![jimi-wiki wiki-list shell](docs/assets/shell-wikis.png)

## Stack

- **Next.js 16** (App Router, React 19) — web UI + `/api/*` routes
- **PostgreSQL 17 + pgvector** — data + embedding vector search (docker compose)
- **Prisma 7** — ORM; generated client lives in `src/generated/prisma`
- **Auth.js (next-auth v5)** — local email + password (argon2id) auth. Self-host oriented, no external
  OAuth required (see `AUTH_MODE`)
- **Gemini** (`@ai-sdk/google` / `@google/genai`) — generation + embeddings. (Optional) override ingest
  with Anthropic models
- **pnpm** — package manager

## Getting started

Prerequisites: Node 20+, pnpm, Docker.

```bash
# 1. Dependencies
pnpm install

# 2. Env vars — copy .env.example and fill values (at minimum GEMINI_API_KEY)
cp .env.example .env

# 3. Start Postgres (pgvector) — container jimi-wiki-db, local port 5433
pnpm db:up

# 4. Apply schema migrations
pnpm db:migrate

# 5. Dev server (port 3007)
pnpm dev

# 6. In another terminal, the ingest worker
pnpm worker
```

Open http://localhost:3007 → **on first visit, create the first admin account at `/setup`** (see Auth
below). To reach it from a remote/other host, check `allowedDevOrigins` in `next.config`.

### Auth & accounts (`AUTH_MODE`)

The app manages accounts directly, with no external OAuth. Pick a mode via `AUTH_MODE` in `.env`:

| Mode | Login | For | Account management |
|---|---|---|---|
| `single` | none | just me (localhost only recommended) | one implicit owner |
| `local` (default) | email + password (argon2id) | small internal team | admin-created / invite links |
| `oidc` | external OIDC | orgs with an IdP | *phase-2 (not wired yet)* |

**Create the first admin (`local`):** one of two ways.
- **Web**: on first visit, enter the admin email/password at `/setup`. (Locks automatically once a user exists.)
- **Headless**: set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` and run `pnpm db:seed`.

Afterwards the admin creates users at **`/admin/users`** or issues **invite links** (`/invite/<token>`).
**There is no public sign-up** — only invited people can create accounts.

> **If you access it over a network**, passwords travel over the wire, so avoid `single` (no login) and
> use `local`. If you connect from outside your home, put it behind **Tailscale** (private VPN, no port
> exposure) or a reverse proxy (Caddy / Cloudflare Tunnel) with HTTPS in front.

### Key environment variables (see `.env.example`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (docker compose default: `postgresql://jimi:jimi@localhost:5433/jimi`) |
| `AUTH_SECRET` | session/JWT signing key (`openssl rand -base64 32`) |
| `AUTH_MODE` | auth mode: `single` \| `local` (default) \| `oidc` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | (optional) first-run admin bootstrap for `pnpm db:seed`. Leave blank if using web `/setup` |
| `APP_URL` | public app URL — used to build absolute invite/share links |
| `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini generation + embedding key (same value) |
| `ANTHROPIC_API_KEY` | (optional) needed when a model is `claude-*` |
| `OPENAI_API_KEY` | (optional) needed when a model is `gpt-*`/`o*` (chat/ingest/lint) |
| `OPENAI_BASE_URL` | (optional, personal-local only) OpenAI-compatible proxy URL. ⚠️ Do not use in public deployments |
| `OPENAI_OAUTH_PERSONAL` | (optional, personal-local only) `1` uses your ChatGPT-subscription OAuth via `pnpm openai:login`. ⚠️ Personal self-host only; don't open it as a service to multiple people (ToS). See [`docs/openai-oauth.md`](docs/openai-oauth.md) |
| `EMBED_PROVIDER` / `EMBED_BASE_URL` | embedding provider: `local` (self-hosted bge-m3 via the `embeddings` compose service) \| `gemini`. Defaults to local when `EMBED_BASE_URL` is set. With `local`, embeddings need no external API key |
| `EMBED_MODEL` / `EMBED_DIM` | embedding model/dim (default local=`BAAI/bge-m3`, gemini=`gemini-embedding-001`; dim `1024`). ⚠️ Changing the dim requires a DB migration + reindex; switching providers only requires a reindex |
| `INGEST_MODEL` / `GEN_MODEL` / `CHAT_MODEL` | ingest / query·lint / chat models. `gemini-*` \| `claude-*` \| `gpt-*` can be mixed (default Gemini) |
| `DAILY_TOKEN_LIMIT` | per-user daily generative-token ceiling |
| `WORKER_POLL_MS` | ingest worker polling interval |

### API key isolation & cost safety ⚠️

The app reads keys from `process.env`. **By the standard (Next.js / dotenv) precedence, environment variables exported in your shell take priority over `.env`** — so if a personal `OPENAI_API_KEY` is exported in your `.zshrc`, that shell key is billed regardless of what `.env` contains (or even if it's empty). To avoid spending on a key by accident:

- **Docker (most reliable)**: `docker compose` reads keys only via `env_file: .env`, and **the container does not inherit the host shell env** → only `.env` is used, fully isolated. If cost is a concern, running via Docker is the answer.
- **Local (non-Docker)**: keep API keys **only in the project `.env`, not exported in your shell**. Check your current shell with `env | grep -E 'OPENAI|GEMINI|ANTHROPIC|_API_KEY'` — whatever shows up there is what the app uses. (For per-directory isolation, use [`direnv`](https://direnv.net).)
- **Do NOT use `override: true` to make `.env` win over the shell** — it only applies to the dotenv-loaded worker/scripts, not the Next web server (which has its own loader), so the web and worker could end up using **different keys**, which is worse.
- **Use a dedicated API key**: issuing a separate key just for this app (not shared with other tools) lets you track usage/cost independently and revoke only this key. Setting a **usage budget** in the provider console adds a second safety net.

On startup the `worker` logs the **active provider keys and their source (`.env` vs shell/env ⚠️)**, so you can immediately see which key you're being billed on.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | dev server (port 3007) |
| `pnpm dev:all` | web + worker together (merged logs, Ctrl-C stops both) |
| `pnpm start:all` | production web (`start`) + worker together |
| `pnpm worker` | worker that processes pending ingest jobs |
| `pnpm build` / `pnpm start` | production build / server |
| `pnpm db:up` | start Postgres container |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:seed` | first-run admin bootstrap (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) |
| `pnpm test` | unit tests (pure logic; no DB required) |
| `pnpm smoke` | smoke test (requires a running DB) |
| `pnpm apikey:issue` | issue an API key via CLI |
| `pnpm openai:login` | (personal) ChatGPT-subscription OAuth login — use with `OPENAI_OAUTH_PERSONAL=1` |
| `pnpm check:rules` | ontology rules ↔ skill parity check |
| `pnpm mcp` | run the MCP server (`mcp/server.mjs`) |

## Deployment notes

Self-host is the assumption — put it on an internal server (or your own host) and manage accounts
directly with `AUTH_MODE=local`. Split into three processes (same repo):

- `web`: `pnpm build` then `pnpm start`
- `worker`: `pnpm worker`
- `postgres`: `pgvector/pgvector:pg17`

`web` and `worker` share the same `DATABASE_URL`, `AUTH_SECRET`, `GEMINI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, and `AUTH_MODE`. On the first deploy, bootstrap the admin with
`ADMIN_EMAIL`/`ADMIN_PASSWORD` or create it at `web`'s `/setup`. If exposed to the internet, front it
with a reverse proxy for HTTPS or place it behind a private network like Tailscale.

**All-in-one with Docker**: `docker compose up --build` brings up `db`, `web` (3007), and `worker`
together. `web` and `worker` share one image (role selected via `command`) and read `.env` via
`env_file`, but `DATABASE_URL` is overridden for the container (`db:5432`). ChatGPT OAuth tokens live in
the `jimi-oauth` volume (`/data`) so web and worker can share them. For development, `pnpm dev:all`
(web + worker) is enough.

**Model selection · ChatGPT login**: admins pick the chat/ingest/query-lint models per provider at
**`/admin/settings`** (applied without a restart) and can log in/out of ChatGPT-subscription OAuth via
device code, no browser needed. Env vars (`CHAT_MODEL`, etc.) are the fallback when unset. See
[`docs/openai-oauth.md`](docs/openai-oauth.md) for the OAuth flow.

Health checks:

- `/api/healthz`: process liveness
- `/api/readyz`: DB connectivity + required env vars

## Programmatic access (REST / MCP)

External agents can maintain the wiki without the app's built-in AI. **The web UI authenticates with a
session (cookie); programmatic calls authenticate with an API key (Bearer).**

1. **Issue an API key**: after login, at `/keys`. You can set wiki scope, a ceiling role (read-only /
   edit), and expiry. The raw key is shown only once at issue time.
2. **REST**: call `/api/wikis/{slug}/*` with the `Authorization: Bearer <KEY>` header. Full reference in
   [`docs/rest-api.md`](docs/rest-api.md).
3. **MCP**: register `mcp/server.mjs` with an MCP client (Claude Code, etc.) to expose the content API as
   tools. Detailed workflow in [`skills/wiki-ingest/SKILL.md`](skills/wiki-ingest/SKILL.md).

   ```bash
   claude mcp add jimi-wiki \
     -e JIMI_WIKI_URL=http://localhost:3007 \
     -e JIMI_WIKI_API_KEY=<key> \
     -e JIMI_WIKI_SLUG=<wiki-slug> \
     -- node <repo>/mcp/server.mjs
   ```

> Routes that consume the built-in AI (`/ingest`, `/query`, `/reindex`, `/lint?deep`) are
> **session-only**. With an API key you author the wiki directly using primitives like `create_source` +
> `write_page`, and run the built-in AI ingest from the web UI. See `docs/rest-api.md` for the full policy.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see [SECURITY.md](SECURITY.md) —
please don't open a public issue.

## License

**MIT** — see [`LICENSE`](LICENSE). Use, modify, redistribute, and commercial use are all freely
permitted; just keep the copyright and license notice.
