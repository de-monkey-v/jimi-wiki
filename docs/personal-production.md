# Personal production runbook

This runbook moves a single-owner Jimi Wiki from tmux development processes to a private Tailscale HTTPS endpoint backed by `systemd --user` services. PostgreSQL and the embedding server remain in Docker through the explicit `docker-compose.production.yml`; the default `docker-compose.yml` is development-only. The web, worker, and pinned Codex OAuth proxy run on the host.

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

## Build and install

Use a committed release ref; never deploy a dirty checkout.

```bash
release="$(ops/deploy.sh build v0.3.0)"
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

Rotate PostgreSQL only after `app.env` exists. The script always selects `docker-compose.production.yml`; it changes the live role password, `DATABASE_URL`, and the production Compose container environment together, and force-recreates DB/embedding so their loopback-only bindings take effect:

```bash
ops/rotate-db-password.sh
```

## Backup, account reset, and activation

Save `~/.config/jimi-wiki/backup-passphrase` in a password manager before proceeding. Stop every writer (tmux web/worker or the systemd units), then create and actually restore the encrypted backup:

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

Keep `v0.2.0` as the previous release. Before the first research row is created, `ops/deploy.sh rollback` may swap the release symlink back and restart services. Once research rows exist, a rollback that also needs the old database contract must stop every writer and restore the encrypted backup taken immediately before this cutover; the release symlink alone is not a database rollback. For an account-reset rollback, restore that same database/blob backup, then run `ops/hermes-jimi-mcp.sh restore-pre-reset` to restore the protected matching Hermes key/config snapshot.

`linger=yes` restarts user services after the WSL distribution starts. The Windows logon task starts the distribution; test a real Windows reboot separately because that also exercises Docker Desktop startup ordering.
