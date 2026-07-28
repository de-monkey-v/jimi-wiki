#!/usr/bin/env bash
# 운영 컨테이너(db·embeddings)를 다루는 유일한 진입점.
#
# 저장소에서 맨손으로 `docker compose ...`를 치면 개발용 docker-compose.yml과
# 개발용 저장소 .env가 잡힌다. 그렇게 뜬 운영 DB가 26일간 `0.0.0.0:5433`으로
# tailnet 전체에 노출된 채 개발 비밀번호를 물고 돌았던 전례가 있다(2026-07-02~28).
# 운영 compose 호출은 반드시 이 스크립트를 거쳐, env-file과 compose 파일이
# 호출자마다 달라질 여지를 없앤다.
#
# 예) ops/compose.sh up -d --force-recreate db
#     ops/compose.sh ps
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${JIMI_ENV_FILE:-$HOME/.config/jimi-wiki/app.env}"
production_compose="$repo/docker-compose.production.yml"

usage() {
  echo "usage: $0 [--dry-run] <subcommand> [args...]" >&2
  echo "  e.g. $0 up -d --force-recreate db" >&2
  exit 2
}

# 서브커맨드 앞에 오는 전역 플래그는 compose 파일·project·env-file을 바꿀 수 있다.
# 차단 목록으로 막으면 docker compose에 플래그가 추가될 때마다 목록이 낡고, 값을 별도
# 토큰으로 받는 플래그(`--ansi never -f dev.yml`)가 스캔을 조기 종료시키는 함정도 있다.
# 그래서 차단이 아니라 허용 목록으로 간다 — 이 진입점에서 의미 있는 전역 플래그는
# --dry-run 하나뿐이고, 나머지는 전부 거부한다.
#
# 서브커맨드 이후의 인자는 손대지 않는다. `logs -f db`의 -f는 follow이고
# `run -p 1:1`의 -p는 publish다 — 전역 플래그와 이름만 같을 뿐이다.
global_flags=()
while [[ $# -gt 0 && "$1" == -* ]]; do
  case "$1" in
    --dry-run) global_flags+=("$1"); shift ;;
    *)
      echo "$0: global flag '$1' is not allowed — this entry point pins the production compose file, env file, and project" >&2
      echo "  운영 설정을 바꿔야 한다면 docker-compose.production.yml 또는 app.env를 고치세요." >&2
      exit 2
      ;;
  esac
done
[[ $# -gt 0 ]] || usage

# 같은 값을 환경변수로도 줄 수 있다. compose 파일과 env-file은 아래 명시 플래그가 이기지만,
# project 이름은 그렇지 않아 갈릴 수 있고 그러면 볼륨 네임스페이스까지 달라져 빈 데이터로 뜬다.
# 그래서 지우는 것에 더해 project도 플래그로 못박는다 — unset은 셸 함수로 덮으면 무력화되지만
# 플래그는 환경변수를 항상 이긴다. 값은 docker-compose.production.yml의 `name:`과 같아야 한다.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_PROFILES
project_name="jimi-wiki-app"
[[ -f "$env_file" ]] || { echo "missing production env: $env_file" >&2; exit 1; }
[[ -f "$production_compose" ]] || { echo "missing $production_compose" >&2; exit 1; }
[[ "$(stat -c %a "$env_file")" == "600" ]] || { echo "$env_file must be mode 600" >&2; exit 1; }

cd "$repo"
exec docker compose "${global_flags[@]+"${global_flags[@]}"}" \
  --project-name "$project_name" --env-file "$env_file" --file "$production_compose" "$@"
