#!/usr/bin/env bash
# 모든 검사를 끝까지 돌린 뒤 실패를 한꺼번에 보고한다.
#
# 예전에는 `set -e`로 첫 실패에서 멈췄다. 그래서 가용성 검사(readyz)가 503으로 죽는 동안
# 그 뒤에 있던 보안 검사(loopback 바인딩)가 26일간 실행조차 되지 못했고, 운영 DB가
# tailnet에 열려 있다는 사실이 그 그늘에 묻혔다(2026-07-02~28). 검사끼리 서로를
# 가리지 않게 하려면 조기 종료를 없애는 수밖에 없다.
#
# 그 대신 `set -e`가 잡아주던 것을 잃으므로, 각 검사는 반드시 check/check_shell을 거쳐
# 결과가 명시적으로 수집되게 한다.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failures=()

# check <라벨> <명령...> — 명령이 실패하면 출력과 함께 실패로 기록한다.
check() {
  local label="$1"; shift
  local out status
  out="$("$@" 2>&1)"; status=$?
  if ((status != 0)); then
    failures+=("$label: ${out:-exit $status}")
  fi
}

# check_shell <라벨> <셸 코드> — 파이프라인·리다이렉션이 필요한 검사용.
check_shell() {
  local label="$1" code="$2"
  local out status
  out="$(bash -c "$code" 2>&1)"; status=$?
  if ((status != 0)); then
    failures+=("$label: ${out:-exit $status}")
  fi
}

for unit in jimi-wiki-web.service jimi-wiki-worker.service jimi-wiki-codex-proxy.service; do
  check "$unit" systemctl --user is-active --quiet "$unit"
done

check "web readyz" curl --fail --silent --show-error --max-time 15 http://127.0.0.1:23007/api/readyz
check "codex proxy" curl --fail --silent --show-error --max-time 15 http://127.0.0.1:10531/v1/models

check_shell "port bindings" '
  bad="$(ss -H -ltn | awk '"'"'
    $4 ~ /:(23007|5433|8080|10531)$/ && $4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/ { print $4 }
  '"'"')"
  [[ -z "$bad" ]] || { echo "exposed outside loopback: $bad"; exit 1; }
'

# 떠 있는 컨테이너가 운영 설정에서 나왔는지. 파일만 보면 알 수 없는 부분이다.
check "production containers" ./ops/check-production-containers.sh

check_shell "tailscale serve" '
  SERVE_STATUS="$(tailscale serve status --json)" /usr/bin/node <<"NODE"
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
'

check_shell "tailscale funnel" '
  if tailscale funnel status | grep -qi "Funnel on"; then
    echo "Funnel must remain disabled"; exit 1
  fi
'

check "hermes key expiry" /usr/bin/node --require ./scripts/server-only-shim.cjs --import tsx ./scripts/check-hermes-key-expiry.ts

if ((${#failures[@]})); then
  printf 'Jimi Wiki health check FAILED (%d):\n' "${#failures[@]}" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi

echo "Jimi Wiki health check OK"
