#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --app-url https://host.ts.net --login user@example.com [--source .env]" >&2
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
[[ "$app_url" == https://* && -n "$login" && -f "$source_env" ]] || usage

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
set_key "$target.tmp" EMBED_BASE_URL "http://127.0.0.1:8080"
set_key "$target.tmp" OPENAI_BASE_URL "http://127.0.0.1:10531/v1"
chmod 600 "$target.tmp"
mv "$target.tmp" "$target"
echo "prepared $target (mode 600); AUTH_SECRET rotated and Tailscale mode enabled"
