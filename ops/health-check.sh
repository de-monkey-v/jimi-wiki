#!/usr/bin/env bash
set -euo pipefail

units=(jimi-wiki-web.service jimi-wiki-worker.service jimi-wiki-codex-proxy.service)
for unit in "${units[@]}"; do
  systemctl --user is-active --quiet "$unit" || { echo "$unit is not active" >&2; exit 1; }
done

curl --fail --silent --show-error --max-time 15 http://127.0.0.1:23007/api/readyz >/dev/null
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:10531/v1/models >/dev/null

bad_bindings="$(ss -H -ltn | awk '
  $4 ~ /:(23007|5433|8080|10531)$/ && $4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/ { print $4 }
')"
if [[ -n "$bad_bindings" ]]; then
  echo "Jimi port exposed outside loopback: $bad_bindings" >&2
  exit 1
fi

serve_status="$(tailscale serve status --json)"
SERVE_STATUS="$serve_status" /usr/bin/node <<'NODE'
const config = JSON.parse(process.env.SERVE_STATUS ?? "");
const appUrl = new URL(process.env.APP_URL ?? "");
if (appUrl.protocol !== "https:" || (appUrl.port && appUrl.port !== "443")) {
  throw new Error("APP_URL must use Tailscale HTTPS port 443");
}
const hostPort = `${appUrl.hostname}:443`;
const tcp = config.TCP?.["443"];
const proxy = config.Web?.[hostPort]?.Handlers?.["/"]?.Proxy;
const target = typeof proxy === "string" ? new URL(proxy) : null;
if (tcp?.HTTPS !== true || !target || target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.port !== "23007" || target.pathname !== "/" || target.search || target.hash) {
  throw new Error(`Tailscale Serve ${hostPort} must proxy / to http://127.0.0.1:23007`);
}
if (Object.values(config.AllowFunnel ?? {}).some(Boolean)) {
  throw new Error("Tailscale Funnel must remain disabled");
}
NODE

funnel_status="$(tailscale funnel status)"
if grep -qi 'Funnel on' <<<"$funnel_status"; then
  echo "Tailscale Funnel must remain disabled" >&2
  exit 1
fi

/usr/bin/node --require ./scripts/server-only-shim.cjs --import tsx ./scripts/check-hermes-key-expiry.ts
echo "Jimi Wiki health check OK"
