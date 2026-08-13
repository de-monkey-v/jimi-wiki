#!/usr/bin/env bash
# deploy.sh 의 wait_ready 계약 테스트.
#
# 확인하는 것: codex 프록시가 죽어 있어도 web 이 살아 있으면 배포가 ready 로 판정된다.
# 그 프록시는 pr-review-bot 도 쓰는 공용 인프라라, 그쪽 장애가 이 앱의 멀쩡한 릴리스를
# 롤백시켜서는 안 된다(deploy.sh 의 wait_ready 실패는 activate 를 통째로 되돌린다).
#
# 실행: bash ops/deploy-ready.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/deploy.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"; [[ -n "${fake:-}" ]] && kill "$fake" 2>/dev/null || true' EXIT

# 아무도 듣지 않는 포트를 골라 가짜 readyz 를 띄운다(고정 포트는 병렬 실행에서 충돌한다).
port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -c "
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s): s.send_response(200); s.end_headers(); s.wfile.write(b'ok')
    def log_message(*a): pass
socketserver.TCPServer(('127.0.0.1', $port), H).serve_forever()
" &
fake=$!

for _ in $(seq 1 50); do
  curl --fail --silent --max-time 1 "http://127.0.0.1:$port/" >/dev/null 2>&1 && break
  sleep 0.1
done

# wait_ready 만 떼어내 구동한다. deploy.sh 본문은 서브커맨드를 요구하므로 source 할 수 없다.
sed -n '/^wait_ready()/,/^}/p' "$deploy" > "$tmp/wait_ready.sh"
[[ -s "$tmp/wait_ready.sh" ]] || { echo "FAIL: deploy.sh 에서 wait_ready 를 찾지 못했다"; exit 1; }
# shellcheck source=/dev/null
source "$tmp/wait_ready.sh"

# 프록시 주소는 확실히 죽은 곳을 준다. 예전 구현은 이 값을 AND 조건으로 요구했다.
if JIMI_READY_URL="http://127.0.0.1:$port/" \
   JIMI_PROXY_READY_URL="http://127.0.0.1:1/dead" \
   JIMI_READY_TIMEOUT=4 \
   wait_ready; then
  echo "ok - 프록시가 죽어도 web 이 살아 있으면 ready 로 판정한다"
else
  echo "not ok - 프록시 장애가 배포를 롤백시킨다(wait_ready 가 실패했다)"
  exit 1
fi

# 반대 방향: web 이 죽으면 여전히 실패해야 한다(게이트를 통째로 없앤 것이 아님).
if JIMI_READY_URL="http://127.0.0.1:1/dead" \
   JIMI_READY_TIMEOUT=2 \
   wait_ready 2>/dev/null; then
  echo "not ok - web 이 죽었는데도 ready 로 판정했다"
  exit 1
else
  echo "ok - web 이 죽으면 여전히 실패한다"
fi
