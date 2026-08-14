#!/usr/bin/env bash
# deploy.sh 의 wait_ready 계약 테스트.
#
# 확인하는 것: codex 프록시가 죽어 있어도 web 이 살아 있으면 배포가 ready 로 판정된다.
# 그 프록시는 pr-review-bot 도 쓰는 공용 인프라라, 그쪽 장애가 이 앱의 멀쩡한 릴리스를
# 롤백시켜서는 안 된다(deploy.sh 의 wait_ready 실패는 activate 를 통째로 되돌린다).
#
# 그리고: 기대 sha 를 주면 200 만으로는 ready 로 인정하지 않는다. 재시작이 실패해 옛
# 릴리스가 계속 응답하는 경우를 "배포 성공" 으로 읽으면 안 되기 때문이다.
#
# 실행: bash ops/deploy-ready.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/deploy.sh"
tmp="$(mktemp -d)"
# 보조 서버는 전부 EXIT 트랩이 정리한다. 본문 중간에서 죽이면, 뒤에 오는 검사가
# "신원 불일치라서 실패"가 아니라 "포트가 죽어서 실패"로 통과해 오라클이 무의미해진다.
cleanup() {
  local pid
  for pid in "${fake:-}" "${arrayed:-}" "${plain:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  rm -rf -- "$tmp"
}
trap cleanup EXIT

# 아무도 듣지 않는 포트를 골라 가짜 readyz 를 띄운다(고정 포트는 병렬 실행에서 충돌한다).
# 응답 본문은 실제 /api/readyz 와 같은 모양이라, 신원 대조가 실물에서 하는 일과 같아진다.
served_sha="1111111111111111111111111111111111111111"
port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -c "
import http.server, socketserver, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        body = json.dumps({'ok': True, 'db': True, 'release': '$served_sha', 'missing': []}).encode()
        s.send_response(200); s.send_header('Content-Type', 'application/json'); s.end_headers(); s.wfile.write(body)
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

# 기대 sha 가 서비스 중인 sha 와 같으면 ready 다.
if JIMI_READY_URL="http://127.0.0.1:$port/" \
   JIMI_READY_TIMEOUT=4 \
   wait_ready "$served_sha"; then
  echo "ok - 기대 릴리스가 응답하면 ready 로 판정한다"
else
  echo "not ok - 기대 릴리스가 응답하는데 ready 로 판정하지 못했다"
  exit 1
fi

# 핵심: 200 이 와도 다른(=옛) 릴리스가 응답 중이면 ready 가 아니다.
# 이 검사가 없으면 재시작 실패가 "배포 성공" 으로 보고된다.
if JIMI_READY_URL="http://127.0.0.1:$port/" \
   JIMI_READY_TIMEOUT=2 \
   wait_ready "2222222222222222222222222222222222222222" 2>/dev/null; then
  echo "not ok - 옛 릴리스가 응답하는데 ready 로 판정했다"
  exit 1
else
  echo "ok - 옛 릴리스가 200 을 줘도 ready 로 판정하지 않는다"
fi



# 문자열이 아닌 release 는 신원이 아니다. String() 강제였다면 ["<sha>"] 가 sha 와 같아져
# 통과한다 — 응답을 만드는 쪽이 바뀌어도 게이트가 뚫리지 않아야 한다.
array_port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -c "
import http.server, socketserver, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        body = json.dumps({'ok': True, 'db': True, 'release': ['$served_sha'], 'missing': []}).encode()
        s.send_response(200); s.send_header('Content-Type', 'application/json'); s.end_headers(); s.wfile.write(body)
    def log_message(*a): pass
socketserver.TCPServer(('127.0.0.1', $array_port), H).serve_forever()
" &
arrayed=$!
for _ in $(seq 1 50); do
  curl --fail --silent --max-time 1 "http://127.0.0.1:$array_port/" >/dev/null 2>&1 && break
  sleep 0.1
done
if JIMI_READY_URL="http://127.0.0.1:$array_port/" \
   JIMI_READY_TIMEOUT=2 \
   wait_ready "$served_sha" 2>/dev/null; then
  echo "not ok - release 가 문자열이 아닌데 ready 로 판정했다"
  exit 1
else
  echo "ok - release 가 문자열이 아니면 ready 로 판정하지 않는다"
fi

plain_port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s): s.send_response(200); s.end_headers(); s.wfile.write(b'ok')
    def log_message(*a): pass
socketserver.TCPServer(('127.0.0.1', $plain_port), H).serve_forever()
" &
plain=$!
for _ in $(seq 1 50); do
  curl --fail --silent --max-time 1 "http://127.0.0.1:$plain_port/" >/dev/null 2>&1 && break
  sleep 0.1
done
if JIMI_READY_URL="http://127.0.0.1:$plain_port/" \
   JIMI_READY_TIMEOUT=2 \
   wait_ready "$served_sha" 2>/dev/null; then
  echo "not ok - 릴리스 신원이 없는 200 을 ready 로 판정했다"
  exit 1
else
  echo "ok - 릴리스 신원이 없는 200 은 ready 로 판정하지 않는다"
fi

# 게이트의 on/off 는 "인자를 줬는가"이지 "인자가 비지 않았는가"가 아니다. 빈 기대값이
# 흘러들어도 fail-closed 여야 한다.
#
# 여기서 반드시 **신원을 읽어낼 수 없는 응답**과 짝지어야 한다. 유효한 sha 를 주는 서버로만
# 검사하면 빈 기대값과 sha 가 달라서 어차피 실패하므로, "빈 기대값 == 빈 served" 로 일치
# 판정이 나는 진짜 구멍을 놓친다. 게이트를 켜달라고 부른 호출이 게이트를 끄는 경로다.
for endpoint in "$plain_port" "$port" "$array_port"; do
  if JIMI_READY_URL="http://127.0.0.1:$endpoint/" \
     JIMI_READY_TIMEOUT=2 \
     wait_ready "" 2>/dev/null; then
    echo "not ok - 빈 기대값인데 ready 로 판정했다(포트 $endpoint) — 게이트가 조용히 꺼진다"
    exit 1
  fi
done
echo "ok - 빈 기대값은 어떤 응답에도 fail-closed 다"

# activate 는 .jimi-release 의 존재만이 아니라 내용까지 본다. 빈 파일/깨진 값이 통과하면
# wait_ready 가 기대 sha 없이 불려 도달성만 보는 예전 동작으로 조용히 되돌아간다 =
# 신원 게이트가 스스로 꺼진다. 서비스를 멈추기 전에 거부해야 되돌릴 것이 없다.
for bogus in "" "not-a-sha" "ABEFFE4C946A326370BD29A482BA60208E80264E" "abeffe4"; do
  rel="$(mktemp -d "$tmp/release.XXXXXX")"
  printf '%s' "$bogus" > "$rel/.jimi-release"
  out="$(JIMI_STATE_DIR="$tmp/state" bash "$deploy" activate "$rel" 2>&1)" && rc=0 || rc=$?
  if (( rc == 0 )); then
    echo "not ok - 깨진 .jimi-release($(printf '%q' "$bogus"))로 activate 가 진행됐다"
    exit 1
  fi
  if ! grep -q 'release identity is missing or malformed' <<<"$out"; then
    echo "not ok - 깨진 .jimi-release($(printf '%q' "$bogus"))가 신원 검증이 아닌 이유로 멈췄다: $out"
    exit 1
  fi
done
echo "ok - activate 가 비었거나 깨진 .jimi-release 를 서비스 정지 전에 거부한다"
