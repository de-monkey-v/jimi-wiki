#!/usr/bin/env bash
# state_dir 기본값 계약 테스트.
#
# 확인하는 것: JIMI_STATE_DIR 를 지운 채 ops/ 의 스크립트를 기동하면 어느 것도
# $HOME/releases/jimi-wiki 를 만들거나 참조하지 않고, 전부 $HOME/.local/share/jimi-wiki 를
# 상태 디렉터리로 삼는다.
#
# 왜 필요한가: 기본값이 실제 운영 경로와 어긋나 있으면, 환경변수를 잊은 한 번의 실행이
# 엉뚱한 트리에 릴리스를 만든다. 그 트리에는 current 심링크가 없으므로 activate 가
# "최초 cutover" 로 오인해 마이그레이션 전 백업을 건너뛰고, 마이그레이션만 되돌릴 수 없게
# 적용된 채 서비스는 옛 릴리스 그대로 남는다.
#
# 오라클은 소스 문자열이 아니다. 스크립트를 실제로 기동해 (a) bash 가 런타임에 확장한
# 값과 (b) 파일시스템에 실제로 생긴 디렉터리를 본다.
#
# 실행: bash ops/state-dir-default.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

fake_home="$tmp/home"
mkdir -p "$fake_home"
bad="$fake_home/releases/jimi-wiki"
good="$fake_home/.local/share/jimi-wiki"

# systemctl·loginctl 은 실제 사용자 매니저를 건드리므로 스텁으로 가린다. 이것들을 그대로
# 두면 테스트가 운영 유닛을 daemon-reload·enable 한다.
stub="$tmp/stub"
mkdir -p "$stub"
for cmd in systemctl loginctl; do
  printf '#!/bin/sh\nexit 0\n' > "$stub/$cmd"
  chmod +x "$stub/$cmd"
done

# prepare-env.sh 는 --source 로 준 env 파일이 실재해야 인자 검증을 통과한다. 체크아웃의
# .env 에 기대면 이 테스트는 개발 워크트리에서만 통과하고 깨끗한 클론에서는 관측 자체를
# 못 한다 — 프로브가 스스로 입력을 만든다.
source_env="$tmp/source.env"
printf 'DATABASE_URL=postgresql://jimi:x@127.0.0.1:5433/jimi?schema=public\nAUTH_SECRET=x\n' \
  > "$source_env"

status=0
note() { printf '%s\n' "$1"; }
bad_hit() {
  note "not ok - $1 이 $bad 를 참조한다"
  status=1
}

# (a) 런타임 확장값 검사 — bash -x 는 스크립트가 실제로 계산한 값을 찍는다.
#     스크립트들은 전제조건이 없어 곧 실패하지만, 그 전에 대입은 이미 확장돼 있다.
expanded() {
  local script="$1"
  shift
  env -u JIMI_STATE_DIR -u JIMI_RELEASE_DIR HOME="$fake_home" PATH="$stub:$PATH" \
    bash -x "$repo/$script" "$@" 2>&1 >/dev/null || true
}

for spec in \
  "ops/backup.sh|state_dir|" \
  "ops/restore-verify.sh|state_dir|" \
  "ops/prepare-env.sh|state_dir|--app-url https://example.ts.net --login user@example.com --source $source_env" \
  "ops/hermes-jimi-mcp.sh|runtime_dir|"
do
  script="${spec%%|*}"; rest="${spec#*|}"
  var="${rest%%|*}"; args="${rest#*|}"
  # shellcheck disable=SC2086
  trace="$(expanded "$script" $args)"
  line="$(printf '%s\n' "$trace" | grep -E "^\+* ?$var=" | head -1 || true)"
  if [[ -z "$line" ]]; then
    note "not ok - $script 에서 $var 확장을 관측하지 못했다"
    status=1
    continue
  fi
  if [[ "$line" == *"$bad"* ]]; then
    bad_hit "$script"
  elif [[ "$line" == *"$good"* ]]; then
    note "ok - $script 의 $var 가 $good 로 확장된다"
  else
    note "not ok - $script 의 $var 가 예상 밖의 값이다: $line"
    status=1
  fi
done

# (b) 파일시스템 효과 검사 — deploy.sh 는 서브커맨드를 고르기 전에 상태 트리를 만든다.
#     실제로 어느 트리가 생기는지가 가장 직접적인 증거다.
env -u JIMI_STATE_DIR HOME="$fake_home" PATH="$stub:$PATH" \
  bash "$repo/ops/deploy.sh" >/dev/null 2>&1 || true
if [[ -d "$bad" ]]; then
  bad_hit "ops/deploy.sh"
elif [[ -d "$good/releases" ]]; then
  note "ok - ops/deploy.sh 가 $good 아래에 상태 트리를 만든다"
else
  note "not ok - ops/deploy.sh 가 상태 트리를 만들지 않았다"
  status=1
fi

# install-systemd.sh 는 유닛까지 설치하므로 스텁 PATH 아래에서만 돌린다.
env -u JIMI_STATE_DIR HOME="$fake_home" PATH="$stub:$PATH" \
  bash "$repo/ops/install-systemd.sh" >/dev/null 2>&1 || true
if [[ -d "$bad" ]]; then
  bad_hit "ops/install-systemd.sh"
elif [[ -d "$good/releases" ]]; then
  note "ok - ops/install-systemd.sh 가 $good 아래에 상태 트리를 만든다"
else
  note "not ok - ops/install-systemd.sh 가 상태 트리를 만들지 않았다"
  status=1
fi

# (c) 설치되는 유닛 자체가 그 경로를 가리켜야 한다. 스크립트만 고치고 유닛을 두면
#     다음 install-systemd.sh 실행이 실행 중 서비스를 없는 경로로 되돌린다.
for unit in "$fake_home/.config/systemd/user"/jimi-wiki-*.service; do
  [[ -e "$unit" ]] || { note "not ok - 설치된 유닛이 없다"; status=1; break; }
  if grep -q '%h/releases/jimi-wiki' "$unit"; then
    bad_hit "$(basename "$unit")"
  fi
done
if (( status == 0 )); then
  note "ok - 설치된 유닛 어느 것도 %h/releases/jimi-wiki 를 가리키지 않는다"
fi

exit "$status"
