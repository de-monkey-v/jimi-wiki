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

# EMBED_BASE_URL에서 포트만 뽑는다. 셸 문자열 가공 대신 표준 URL 파서에 위임한다 —
# 자격증명의 콜론(`http://user:pass@h:9099`), 경로·쿼리의 `@`, IPv6 리터럴의 콜론을
# 손으로 구분하려다 엉뚱한 값을 포트로 오독하면 그대로 감시 구멍이 되기 때문이다.
# 포트가 생략된 주소는 스킴의 기본 포트를 뜻하므로 그 값을 돌려준다.
embed_url_port() {
  [[ -n "${EMBED_BASE_URL:-}" ]] || return 0
  EMBED_BASE_URL="$EMBED_BASE_URL" /usr/bin/node -e '
    try {
      const u = new URL(process.env.EMBED_BASE_URL);
      const fallback = { "http:": "80", "https:": "443" }[u.protocol] ?? "";
      process.stdout.write(u.port || fallback);
    } catch { process.exit(1); }
  ' 2>/dev/null
}
export -f embed_url_port

# 임베딩 포트만 설정값이다 — 나머지 셋은 systemd 유닛과 운영 compose에 고정돼 있다.
# 여기에 8080을 박아두면 그 포트를 옮긴 호스트에서 같은 번호를 쓰는 무관한 서비스를
# "운영 포트가 열렸다"로 오판한다.
#
# compose가 게시하는 EMBED_HOST_PORT와 앱이 다이얼하는 EMBED_BASE_URL의 포트를 둘 다
# 감시한다. 정상 설치에서는 같은 값이라 중복일 뿐이고, 두 값이 어긋난 설치에서 한쪽만
# 보면 반대쪽에 생긴 노출을 놓친다.
check_shell "port bindings" '
  ports="23007|5433|10531"
  unusable=""
  url_port="$(embed_url_port)"
  # 주소가 설정돼 있는데 포트를 못 읽었다. 없는 셈 치고 넘어가면 실제 임베딩 포트가
  # 감시에서 조용히 빠진다.
  [[ -z "${EMBED_BASE_URL:-}" || -n "$url_port" ]] \
    || unusable="$unusable EMBED_BASE_URL=$EMBED_BASE_URL"
  # 첫 항목은 compose가 실제로 게시하는 포트다 — 기본값 표기(`:-8080`)를 운영 compose의
  # `${EMBED_HOST_PORT:-8080}`과 똑같이 맞춘다. 이 키가 없는 구 app.env에서 compose는
  # 8080을 게시하므로, EMBED_BASE_URL이 어디를 가리키든 8080은 감시 대상으로 남아야 한다.
  # 둘째 항목은 앱이 다이얼하는 주소의 포트다(정상 설치에서는 같은 값이라 중복일 뿐이고,
  # 어긋난 설치에서 한쪽만 보면 반대쪽에 생긴 노출을 놓친다).
  for p in "${EMBED_HOST_PORT:-8080}" "$url_port"; do
    [[ -n "$p" ]] || continue
    # 포트로 읽히지 않는 값은 감시 목록에 넣지 않되 조용히 버리지도 않는다. 선행 0(`07000`)도
    # 여기서 걸린다: ss는 `:7000`을 찍으므로 `07000`을 넣은 정규식은 영영 빗나간다.
    if [[ "$p" =~ ^[1-9][0-9]{0,4}$ ]] && (( p <= 65535 )); then
      ports="$ports|$p"
    else
      unusable="$unusable $p"
    fi
  done
  # 포트값이 불량이어도 스캔은 끝까지 돌린다. 여기서 빠져나가면 같은 회차에 열려 있던
  # 5433 같은 진짜 노출이 보고에서 통째로 사라진다.
  bad="$(ss -H -ltn | awk -v ports="$ports" '"'"'
    $4 ~ ":(" ports ")$" && $4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/ { print $4 }
  '"'"')"
  problems=""
  [[ -z "$bad" ]] || problems="$problems; exposed outside loopback: $bad"
  [[ -z "$unusable" ]] || problems="$problems; unusable embedding port:$unusable"
  [[ -z "$problems" ]] || { echo "${problems#; }"; exit 1; }
'

# 두 키는 같은 포트를 가리켜야 한다. 갈리면 컨테이너는 한쪽에 바인딩되고 앱은 다른 쪽으로
# 다이얼해 임베딩만 조용히 죽는다 — 나머지 검사는 전부 통과하므로 발견이 늦는다.
check_shell "embedding port agreement" '
  # 비교 대상은 compose가 실제로 게시하는 포트다 — 키가 없으면 8080을 게시하므로,
  # "EMBED_HOST_PORT 없음 + EMBED_BASE_URL이 8080이 아님"도 어긋난 상태다.
  host_port="${EMBED_HOST_PORT:-8080}"
  url_port="$(embed_url_port)"
  # 주소가 있는데 포트를 못 읽으면 비교 자체가 성립하지 않는다. 조용히 통과시키면
  # 파서가 깨졌을 때 이 검사가 아무것도 보증하지 않으면서 통과한다.
  [[ -z "${EMBED_BASE_URL:-}" || -n "$url_port" ]] \
    || { echo "cannot read a port from EMBED_BASE_URL=$EMBED_BASE_URL"; exit 1; }
  [[ -z "$url_port" || "$host_port" == "$url_port" ]] \
    || { echo "compose publishes ${EMBED_HOST_PORT:-8080 (default)} but EMBED_BASE_URL port is $url_port"; exit 1; }
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
