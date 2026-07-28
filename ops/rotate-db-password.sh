#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${JIMI_ENV_FILE:-$HOME/.config/jimi-wiki/app.env}"
db_container="${JIMI_DB_CONTAINER:-jimi-wiki-db}"
production_compose="$repo/docker-compose.production.yml"
[[ -f "$env_file" ]] || { echo "missing $env_file" >&2; exit 1; }
[[ -f "$production_compose" ]] || { echo "missing $production_compose" >&2; exit 1; }
[[ "$(stat -c %a "$env_file")" == "600" ]] || { echo "$env_file must be mode 600" >&2; exit 1; }

new_password="$(openssl rand -hex 32)"
temp="$env_file.$$.tmp"
awk -v password="$new_password" '
  BEGIN { seen_password=0; seen_url=0 }
  /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=\"" password "\""; seen_password=1; next }
  /^DATABASE_URL=/ { print "DATABASE_URL=\"postgresql://jimi:" password "@127.0.0.1:5433/jimi?schema=public\""; seen_url=1; next }
  { print }
  END {
    if (!seen_password) print "POSTGRES_PASSWORD=\"" password "\""
    if (!seen_url) print "DATABASE_URL=\"postgresql://jimi:" password "@127.0.0.1:5433/jimi?schema=public\""
  }
' "$env_file" > "$temp"
chmod 600 "$temp"

docker exec -i "$db_container" psql -v ON_ERROR_STOP=1 -U jimi -d jimi -v new_password="$new_password" <<'SQL'
ALTER ROLE jimi PASSWORD :'new_password';
SQL
mv "$temp" "$env_file"
# 운영 compose 호출은 ops/compose.sh 하나로 모은다 — env-file·compose 파일이
# 호출자마다 달라지면 개발 설정으로 뜬 운영 컨테이너를 만들어낸다.
JIMI_ENV_FILE="$env_file" "$repo/ops/compose.sh" up -d --force-recreate db embeddings
echo "PostgreSQL role, container environment, production DATABASE_URL, and DB/embedding loopback bindings were applied together"
