#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --app-url https://host.ts.net --login user@example.com [--source .env] [--embed-port 8080]" >&2
  exit 2
}

option() {
  local key="$1"
  shift
  while (( $# > 0 )); do
    if [[ "$1" == "$key" ]]; then printf '%s' "${2:-}"; return; fi
    shift
  done
}

app_url="$(option --app-url "$@")"
login="$(option --login "$@")"
source_env="$(option --source "$@")"
source_env="${source_env:-.env}"
# 임베딩 컨테이너가 잡을 host 포트. 기본 8080은 흔한 번호라 이미 쓰는 호스트가 있다 —
# 그런 곳에서는 이 값만 옮기면 compose 포트 매핑·EMBED_BASE_URL·health-check가 함께 따라간다.
embed_port="$(option --embed-port "$@")"
# 값 없이 `--embed-port`만 주면 option이 빈 문자열을 돌려준다. 그대로 기본값으로 떨어지면
# 포트를 옮겼다고 믿는 채로 8080이 쓰인다 — 플래그를 줬으면 값을 요구한다.
if [[ -z "$embed_port" ]] && printf '%s\n' "$@" | grep -qx -- '--embed-port'; then usage; fi
embed_port="${embed_port:-8080}"
[[ "$app_url" == https://* && -n "$login" && -f "$source_env" ]] || usage
# 선행 0을 금지한다(`^[1-9]`). `07000`은 `(( ))`가 8진수로 받아 검증을 통과하지만,
# docker와 URL 파서는 십진 7000으로 정규화하는 반면 health-check의 포트 정규식에는
# `07000`이 그대로 들어가 `ss` 출력의 `:7000`과 영영 매치되지 않는다 — 즉 이 플래그
# 하나로 임베딩 포트가 loopback 노출 감시에서 통째로 빠진다.
[[ "$embed_port" =~ ^[1-9][0-9]*$ ]] && (( embed_port < 65536 )) || usage

config_dir="$HOME/.config/jimi-wiki"
state_dir="${JIMI_STATE_DIR:-$HOME/.local/share/jimi-wiki}"
target="$config_dir/app.env"
db_container="${JIMI_DB_CONTAINER:-jimi-wiki-db}"
mkdir -p -m 700 "$config_dir" "$state_dir/shared/blobs" "$state_dir/shared/cache"
umask 077
cp "$source_env" "$target.tmp"

set_key() {
  local file="$1" key="$2" value="$3"
  local next="$file.next"
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    $0 ~ "^" key "=" { print key "=\"" value "\""; found=1; next }
    { print }
    END { if (!found) print key "=\"" value "\"" }
  ' "$file" > "$next"
  mv "$next" "$file"
}

current_db_password="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$db_container" | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)"
[[ -n "$current_db_password" ]] || { echo "cannot read current DB password" >&2; exit 1; }
set_key "$target.tmp" POSTGRES_PASSWORD "$current_db_password"
set_key "$target.tmp" DATABASE_URL "postgresql://jimi:$current_db_password@127.0.0.1:5433/jimi?schema=public"
set_key "$target.tmp" AUTH_MODE tailscale
set_key "$target.tmp" APP_URL "$app_url"
set_key "$target.tmp" TAILSCALE_ALLOWED_LOGIN "$login"
set_key "$target.tmp" AUTH_SECRET "$(openssl rand -hex 48)"
set_key "$target.tmp" BLOB_DIR "$state_dir/shared/blobs"
set_key "$target.tmp" MODEL_CATALOG_CACHE "$state_dir/shared/cache/model-catalog.json"
# 두 키는 같은 포트를 가리켜야 한다: EMBED_HOST_PORT는 compose의 호스트 바인딩,
# EMBED_BASE_URL은 web·worker가 그 컨테이너를 찾는 주소다.
set_key "$target.tmp" EMBED_HOST_PORT "$embed_port"
set_key "$target.tmp" EMBED_BASE_URL "http://127.0.0.1:$embed_port"
set_key "$target.tmp" OPENAI_BASE_URL "http://127.0.0.1:10531/v1"
chmod 600 "$target.tmp"
mv "$target.tmp" "$target"
echo "prepared $target (mode 600); AUTH_SECRET rotated, Tailscale mode enabled, embeddings on 127.0.0.1:$embed_port"
