#!/usr/bin/env bash
set -euo pipefail

state_dir="${JIMI_STATE_DIR:-$HOME/.local/share/jimi-wiki}"
env_file="${JIMI_ENV_FILE:-$HOME/.config/jimi-wiki/app.env}"
passphrase_file="${JIMI_BACKUP_PASSPHRASE_FILE:-$HOME/.config/jimi-wiki/backup-passphrase}"
local_dir="$state_dir/backups"
windows_dir="${JIMI_WINDOWS_BACKUP_DIR:-/mnt/d/backups/jimi-wiki}"
runtime_dir="${JIMI_RELEASE_DIR:-$state_dir/current}"
db_container="${JIMI_DB_CONTAINER:-jimi-wiki-db}"
db_user="${JIMI_DB_USER:-jimi}"
db_name="${JIMI_DB_NAME:-jimi}"
[[ -f "$env_file" && -f "$passphrase_file" && -d "$runtime_dir" ]] || { echo "backup prerequisites missing" >&2; exit 1; }
[[ "$(stat -c %a "$env_file")" == "600" && "$(stat -c %a "$passphrase_file")" == "600" ]] || { echo "env and passphrase must be mode 600" >&2; exit 1; }

mkdir -p -m 700 "$local_dir" "$state_dir/tmp"
temp="$(mktemp -d "$state_dir/tmp/backup.XXXXXX")"
web_was_active=0
worker_was_active=0
cleanup() {
  if (( web_was_active == 1 )); then systemctl --user start jimi-wiki-web.service || true; fi
  if (( worker_was_active == 1 )); then systemctl --user start jimi-wiki-worker.service || true; fi
  rm -rf -- "$temp"
}
trap cleanup EXIT

systemctl --user is-active --quiet jimi-wiki-web.service && web_was_active=1 || true
systemctl --user is-active --quiet jimi-wiki-worker.service && worker_was_active=1 || true
(( worker_was_active == 0 )) || systemctl --user stop jimi-wiki-worker.service
(( web_was_active == 0 )) || systemctl --user stop jimi-wiki-web.service

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
[[ -n "${BLOB_DIR:-}" ]] || { echo "BLOB_DIR is required" >&2; exit 1; }

(
  cd "$runtime_dir"
  /usr/bin/node --import tsx ./scripts/content-manifest.ts --blob-dir "$BLOB_DIR" --output "$temp/manifest.json"
)
docker exec "$db_container" pg_dump -U "$db_user" -d "$db_name" --format=custom --no-owner --no-acl > "$temp/database.dump"
mkdir -p "$BLOB_DIR"
tar -C "$BLOB_DIR" -cf "$temp/blobs.tar" .
# 일관된 DB+blob snapshot을 캡았으면 암호화/복제 전에 writer를 바로 복구한다.
if (( web_was_active == 1 )); then systemctl --user start jimi-wiki-web.service; web_was_active=0; fi
if (( worker_was_active == 1 )); then systemctl --user start jimi-wiki-worker.service; worker_was_active=0; fi
release_sha="$(cat "$runtime_dir/.jimi-release" 2>/dev/null || git -C "$runtime_dir" rev-parse HEAD)"
printf '{"createdAt":"%s","release":"%s","dbImage":"%s"}\n' \
  "$(date --utc +%FT%TZ)" "$release_sha" "$(docker inspect -f '{{.Config.Image}}' "$db_container")" > "$temp/metadata.json"

stamp="$(date --utc +%Y%m%dT%H%M%SZ)"
final="$local_dir/jimi-wiki-$stamp.tar.gpg"
tar -C "$temp" -cf - database.dump blobs.tar manifest.json metadata.json \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$passphrase_file" --symmetric --cipher-algo AES256 --output "$final.tmp"
chmod 600 "$final.tmp"
mv "$final.tmp" "$final"
(cd "$local_dir" && sha256sum "$(basename "$final")" > "$(basename "$final.sha256")")
chmod 600 "$final.sha256"

if [[ -d /mnt/d ]]; then
  mkdir -p "$windows_dir"
  cp "$final" "$final.sha256" "$windows_dir/"
  (cd "$windows_dir" && sha256sum --check "$(basename "$final.sha256")")
fi
find "$local_dir" -maxdepth 1 -type f -name 'jimi-wiki-*.tar.gpg*' -mtime +14 -delete
if [[ -d "$windows_dir" ]]; then
  find "$windows_dir" -maxdepth 1 -type f -name 'jimi-wiki-*.tar.gpg*' -mtime +30 -delete
fi
echo "encrypted backup created: $final"
