# Personal production runbook

This runbook moves a single-owner Jimi Wiki from tmux development processes to a private Tailscale HTTPS endpoint backed by `systemd --user` services. PostgreSQL and the embedding server remain in Docker through the explicit `docker-compose.production.yml`; the default `docker-compose.yml` is development-only. The web, worker, and pinned Codex OAuth proxy run on the host.

**Always drive production containers through `ops/compose.sh`.** It is the single entry point that pins `--env-file ~/.config/jimi-wiki/app.env` and `--file docker-compose.production.yml`:

```bash
ops/compose.sh up -d --force-recreate db embeddings
ops/compose.sh ps
```

A bare `docker compose ...` inside the checkout picks up the development compose file and the repository `.env` instead. That is not hypothetical: from 2026-07-02 to 07-28 the production database ran that way, bound to `0.0.0.0:5433` (exposed to the whole tailnet) and holding the development password. Editing a compose file does not fix an already-created container — its port mappings and environment stay until it is recreated. Never merge the two compose files with `-f`; the projects are separate (`jimi-wiki-app` vs `jimi-wiki-dev`) and merging opens both ports.

`ops/check-production-containers.sh` verifies at runtime that the live containers really came from the production compose file and bind only to loopback. `ops/deploy.sh activate` runs it before touching anything (`JIMI_SKIP_CONTAINER_CHECK=1` overrides), and `ops/health-check.sh` includes it.

## Security contract

- Humans use only `https://<device>.<tailnet>.ts.net`. Tailscale Funnel stays off.
- `AUTH_MODE=tailscale` trusts only `Tailscale-User-Login`, with an exact `TAILSCALE_ALLOWED_LOGIN` match.
- Port 23007 listens on `127.0.0.1`. A direct request without the Serve header is unauthenticated. This intentionally limits header spoofing to processes already running on the host.
- Bearer API keys remain independent of browser identity. Keep every agent key wiki-scoped, role-capped, and expiring.
- `~/.config/jimi-wiki/app.env` and `backup-passphrase` must remain mode `0600`.

Tailscale access policy should grant only the owner login to the device's HTTPS port:

```json
{
  "grants": [
    {
      "src": ["<TAILSCALE_ALLOWED_LOGIN>"],
      "dst": ["<device-name>"],
      "ip": ["tcp:443"]
    }
  ]
}
```

Apply and test this in the tailnet policy editor before relying on it. Policy editing is a tailnet control-plane action and is intentionally not automated by repository scripts.

## Release promotion

Development commits land on `develop` freely. Deploying is a separate, explicit act — shipping every commit couples the release cadence to development, and each new build changes the Server Action ids that already-open tabs are holding.

```bash
# 1. Bump package.json's version on develop first; the tag name must match it.
#    e.g. "version": "0.4.0"  →  commit as chore(release): v0.4.0
git checkout main
git merge --ff-only develop
git tag -a v0.4.0 -m "v0.4.0"
git push origin main v0.4.0        # pushing the tag is not optional; the build guard checks it
git checkout develop
```

`ops/deploy.sh build` only accepts a ref that satisfies all of: a real `vX.Y.Z` git tag, a commit reachable from `main`, a tag pushed to origin, and a tag name matching that commit's `package.json` version. Set `JIMI_SKIP_REMOTE_CHECK=1` to bypass the origin check in an emergency.

The release directory records its tag in `.jimi-tag` alongside the commit sha in `.jimi-release`.

The first build generates `~/.config/jimi-wiki/server-actions-key` (mode 600) and reuses it for every later build. It salts the Server Action id hashes, so keeping it stable is what lets an already-open tab survive a deployment — without it, ids for untouched source change on every build. Save it alongside `backup-passphrase`; losing it costs one release's worth of stale tabs, not data.

## Build and install

Use a pushed version tag; never deploy a branch, a bare sha, or a dirty checkout.

```bash
release="$(ops/deploy.sh build v0.4.0)"
ops/prepare-env.sh \
  --app-url https://<device>.<tailnet>.ts.net \
  --login <TAILSCALE_ALLOWED_LOGIN> \
  --source .env
ops/install-systemd.sh
```

Copy the existing blob archive into the persistent path before activation, then verify it byte-for-byte:

```bash
rsync -a --checksum .blobs/ "$HOME/.local/share/jimi-wiki/shared/blobs/"
pnpm content:manifest -- --blob-dir "$HOME/.local/share/jimi-wiki/shared/blobs" --output /tmp/jimi-before.json
```

Rotate PostgreSQL only after `app.env` exists. The script recreates DB/embedding through `ops/compose.sh`, so the role password, `DATABASE_URL`, and the production Compose container environment change together and the loopback-only bindings take effect. Rotating the password without also running `ALTER ROLE` on the live container is what left the two out of sync for weeks in 2026-07 — use the script rather than editing `app.env` by hand:

```bash
ops/rotate-db-password.sh
```

## Backup, account reset, and activation

`ops/deploy.sh activate` takes care of routine backups on its own: after stopping web/worker it compares the release's `prisma/migrations` against the production `_prisma_migrations` table, and runs `ops/backup.sh` right before `migrate deploy` whenever anything is pending (services are already stopped, so `backup.sh` leaves them alone and the snapshot matches the pre-migration state exactly). Releases with no pending migration skip it. A failed backup aborts the activation and leaves the previous release running. `JIMI_SKIP_MIGRATION_BACKUP=1` overrides this.

The steps below are the manual first-cutover procedure. Save `~/.config/jimi-wiki/backup-passphrase` in a password manager before proceeding. Stop every writer (tmux web/worker or the systemd units), then create and actually restore the encrypted backup:

```bash
JIMI_RELEASE_DIR="$release" ops/backup.sh
JIMI_RELEASE_DIR="$release" ops/restore-verify.sh
cat "$HOME/.local/share/jimi-wiki/backups/last-restore-verify.json"
```

With writers still stopped, create a fresh manifest and reset only the browser-account mapping, sessions, unused invites, and old API keys:

```bash
set -a
source "$HOME/.config/jimi-wiki/app.env"
set +a
cd "$release"
pnpm content:manifest -- --output /tmp/jimi-pre-reset.json
ops/hermes-jimi-mcp.sh disconnect
pnpm auth:reset-personal -- \
  --manifest /tmp/jimi-pre-reset.json \
  --confirm RESET_JIMI_PERSONAL_AUTH
ops/deploy.sh activate "$release"
tailscale funnel reset
tailscale serve --bg --https=443 http://127.0.0.1:23007
```

Open the MagicDNS HTTPS URL from a Tailscale device and explicitly claim the single existing owner. If there are zero or multiple owner candidates, the page fails closed and prints the recovery command shape. Supply an immutable existing User ID; recovery never changes memberships or wiki ownership.

## Hermes reconnect

After the browser claim succeeds, rotate the personal agent key directly into the existing protected Hermes profile environment:

```bash
pnpm apikey:issue-hermes -- \
  --env-file "$HOME/.hermes/profiles/wiki-personal/.env" \
  --wiki personal \
  --confirm ROTATE_HERMES_PERSONAL_KEY
ops/hermes-jimi-mcp.sh connect
```

The reconnect command restores a production-release MCP command that references `${JIMI_WIKI_PERSONAL_KEY}`. It does not edit SOUL/profile instructions or global channel/profile routing. Test the Slack URL workflow before removing the old tmux runtime.

## Tailscale health warning on WSL

If `tailscale status` reports the `iptables ... --restore-mark` error on WSL, switch tailscaled's firewall implementation to nftables and restart it:

```bash
sudo sh -c 'printf "PORT=\"41641\"\nFLAGS=\"\"\nTS_DEBUG_FIREWALL_MODE=nftables\n" > /etc/default/tailscaled'
sudo systemctl restart tailscaled
tailscale status
```

This host-level change requires sudo and is deliberately outside user-service installation. Re-check existing firewall and tailnet connectivity immediately after the restart.

## Windows reboot recovery

`ops/install-systemd.sh` enables linger, so the user services recover whenever the WSL distribution starts. Register the included Windows logon task from PowerShell so a Windows login starts that distribution as well (find the exact name with `wsl.exe -l -q`):

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\ops\windows\register-jimi-wsl-startup.ps1 `
  -Distro <exact-wsl-distro-name> `
  -LinuxUser gyu
```

Docker Desktop must also be configured to start at login. Test this with a real Windows reboot; a WSL-only service restart is not equivalent.

## Verification and rollback

```bash
curl -fsS http://127.0.0.1:23007/api/readyz
systemctl --user start jimi-wiki-health.service
ss -ltnp | grep -E ':(23007|5433|8080|10531)\b'
tailscale serve status
tailscale funnel status
```

All four application ports must be loopback-only, readiness must be 200, and Funnel must be off. Verify an old key returns 401, the new personal key succeeds on its wiki, and it gets 404 on another wiki.

`ops/health-check.sh` runs every check to completion and reports all failures together rather than stopping at the first one. It used to exit early, so while readiness was failing with a 503 the loopback-binding check behind it never ran at all — that is how a database exposed to the tailnet stayed hidden for 26 days. Expect `Jimi Wiki health check FAILED (n):` followed by one line per failed check.

The rollback target is whatever `$HOME/.local/share/jimi-wiki/previous` points at; read its `.jimi-tag` to see which release that is. Before the first research row is created, `ops/deploy.sh rollback` may swap the release symlink back and restart services. Once research rows exist, a rollback that also needs the old database contract must stop every writer and restore the encrypted backup taken immediately before this cutover; the release symlink alone is not a database rollback. For an account-reset rollback, restore that same database/blob backup, then run `ops/hermes-jimi-mcp.sh restore-pre-reset` to restore the protected matching Hermes key/config snapshot.

`linger=yes` restarts user services after the WSL distribution starts. The Windows logon task starts the distribution; test a real Windows reboot separately because that also exercises Docker Desktop startup ordering.
