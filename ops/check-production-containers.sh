#!/usr/bin/env bash
# 떠 있는 운영 컨테이너가 정말 운영 설정에서 나왔는지 런타임에 확인한다.
#
# compose 파일을 고쳐도 이미 만들어진 컨테이너의 포트 매핑과 환경변수는 재생성 전까지
# 바뀌지 않는다. 그래서 선언(파일)이 아니라 실제로 떠 있는 컨테이너를 봐야 한다 —
# 2026-07 사고에서 운영 DB는 현재 두 compose 파일 어디에도 없는 조합(`0.0.0.0:5433`)으로
# 26일간 돌았고, 파일만 보면 정상으로 보였다.
#
# 실패해도 즉시 종료하지 않고 모든 문제를 모아 보고한다.
set -uo pipefail

production_compose_basename="docker-compose.production.yml"
dev_compose_basename="docker-compose.yml"
containers=("${JIMI_DB_CONTAINER:-jimi-wiki-db}" "${JIMI_EMBEDDINGS_CONTAINER:-jimi-wiki-embeddings}")
failures=()

for container in "${containers[@]}"; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    failures+=("$container: 컨테이너가 없습니다")
    continue
  fi

  config_files="$(docker inspect "$container" \
    --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null || true)"
  if [[ -z "$config_files" ]]; then
    failures+=("$container: compose 라벨이 없습니다(수동 생성 컨테이너일 수 있음)")
  else
    # 경로 전체가 아니라 basename으로 본다. 체크아웃 위치는 머신마다 다를 수 있다.
    # production 파일명이 dev 파일명을 부분 문자열로 포함하므로, dev 포함 여부는
    # production 이름을 지운 나머지에서 판단한다.
    remainder="${config_files//$production_compose_basename/}"
    if [[ "$config_files" != *"$production_compose_basename"* ]]; then
      # 운영 compose가 아예 없다 — 2026-07 사고가 정확히 이 모양이었다.
      failures+=("$container: 운영 compose에서 생성되지 않았습니다 (config_files=$config_files)")
    elif [[ "$remainder" == *"$dev_compose_basename"* ]]; then
      # 운영·개발을 -f로 합쳐 기동한 경우. 포트가 양쪽 모두 열린다.
      failures+=("$container: 개발 compose가 함께 병합돼 있습니다 (config_files=$config_files)")
    fi
  fi

  # 포트는 loopback 전용이어야 한다. 운영 DB가 tailnet에 열렸던 것이 이 검사의 이유다.
  non_loopback="$(docker inspect "$container" --format \
    '{{range $port, $binds := .NetworkSettings.Ports}}{{range $binds}}{{$port}}={{.HostIp}}:{{.HostPort}} {{end}}{{end}}' 2>/dev/null \
    | tr ' ' '\n' | grep -vE '=(127\.0\.0\.1|::1):' | grep -v '^$' || true)"
  if [[ -n "$non_loopback" ]]; then
    failures+=("$container: loopback 밖 바인딩 — $(tr '\n' ' ' <<<"$non_loopback")")
  fi
done

if ((${#failures[@]})); then
  printf 'production container check FAILED:\n' >&2
  printf '  - %s\n' "${failures[@]}" >&2
  echo "  fix: ops/compose.sh up -d --force-recreate db embeddings" >&2
  exit 1
fi

echo "production containers OK (${containers[*]})"
