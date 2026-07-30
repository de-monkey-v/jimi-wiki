#!/usr/bin/env bash
set -euo pipefail

state_dir="${JIMI_STATE_DIR:-$HOME/releases/jimi-wiki}"
passphrase_file="${JIMI_BACKUP_PASSPHRASE_FILE:-$HOME/.config/jimi-wiki/backup-passphrase}"
runtime_dir="${JIMI_RELEASE_DIR:-$state_dir/current}"
latest="$(find "$state_dir/backups" -maxdepth 1 -type f -name 'jimi-wiki-*.tar.gpg' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[[ -n "$latest" && -f "$passphrase_file" && -d "$runtime_dir" ]] || { echo "restore verification prerequisites missing" >&2; exit 1; }
checksum="$latest.sha256"
[[ -f "$checksum" ]] || { echo "missing backup checksum: $checksum" >&2; exit 1; }
(cd "$(dirname "$latest")" && sha256sum --check "$(basename "$checksum")")

mkdir -p -m 700 "$state_dir/tmp"
temp="$(mktemp -d "$state_dir/tmp/restore.XXXXXX")"
container="jimi-wiki-restore-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf -- "$temp"
}
trap cleanup EXIT

gpg --batch --yes --pinentry-mode loopback --passphrase-file "$passphrase_file" --decrypt "$latest" > "$temp/bundle.tar"
tar -C "$temp" -xf "$temp/bundle.tar"
mkdir -p "$temp/blobs"
tar -C "$temp/blobs" -xf "$temp/blobs.tar"

password="$(openssl rand -hex 32)"
docker run -d --name "$container" -e POSTGRES_USER=jimi -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=jimi \
  -p 127.0.0.1::5432 pgvector/pgvector:pg17 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$container" pg_isready -U jimi -d jimi >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U jimi -d jimi >/dev/null
port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")"
docker cp "$temp/database.dump" "$container:/tmp/database.dump"
docker exec "$container" pg_restore -U jimi -d jimi --no-owner --no-acl --exit-on-error /tmp/database.dump

database_url="postgresql://jimi:$password@127.0.0.1:$port/jimi?schema=public"
(
  cd "$runtime_dir"
  DATABASE_URL="$database_url" env PATH=/usr/bin:/bin /usr/bin/corepack pnpm exec prisma migrate deploy
  DATABASE_URL="$database_url" BLOB_DIR="$temp/blobs" /usr/bin/node --import tsx ./scripts/content-manifest.ts --compare "$temp/manifest.json"
)
page_count="$(docker exec "$container" psql -U jimi -d jimi -Atc 'SELECT count(*) FROM "Page"')"
source_count="$(docker exec "$container" psql -U jimi -d jimi -Atc 'SELECT count(*) FROM "Source"')"
printf '{"verifiedAt":"%s","backup":"%s","pages":%s,"sources":%s}\n' \
  "$(date --utc +%FT%TZ)" "$(basename "$latest")" "$page_count" "$source_count" > "$state_dir/backups/last-restore-verify.json.tmp"
chmod 600 "$state_dir/backups/last-restore-verify.json.tmp"
mv "$state_dir/backups/last-restore-verify.json.tmp" "$state_dir/backups/last-restore-verify.json"
echo "restore verification OK: $(basename "$latest") ($page_count pages, $source_count sources)"
