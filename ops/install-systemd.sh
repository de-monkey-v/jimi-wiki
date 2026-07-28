#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="$HOME/.config/jimi-wiki"
user_units="$HOME/.config/systemd/user"
state_dir="${JIMI_STATE_DIR:-$HOME/releases/jimi-wiki}"
start_timers="${JIMI_START_TIMERS:-1}"
[[ "$start_timers" == "0" || "$start_timers" == "1" ]] \
  || { echo "JIMI_START_TIMERS must be 0 or 1" >&2; exit 2; }
mkdir -p -m 700 "$config_dir" "$state_dir" "$state_dir/releases" "$state_dir/shared/blobs" "$state_dir/shared/cache" "$state_dir/backups" "$state_dir/tmp"
mkdir -p "$user_units"

if [[ ! -f "$config_dir/backup-passphrase" ]]; then
  umask 077
  openssl rand -base64 48 > "$config_dir/backup-passphrase"
fi
chmod 600 "$config_dir/backup-passphrase"

for unit in "$repo"/ops/systemd/*.{service,timer}; do
  install -m 0644 "$unit" "$user_units/$(basename "$unit")"
done
systemctl --user daemon-reload
loginctl enable-linger "$USER"
systemctl --user enable \
  jimi-wiki-web.service jimi-wiki-worker.service jimi-wiki-codex-proxy.service
timer_units=(
  jimi-wiki-health.timer jimi-wiki-backup.timer jimi-wiki-restore-verify.timer
)
systemctl --user enable "${timer_units[@]}"
timer_state="deferred"
if [[ "$start_timers" == "1" ]]; then
  systemctl --user start "${timer_units[@]}"
  timer_state="started"
fi

echo "systemd units installed (timers $timer_state). Save $config_dir/backup-passphrase in the password manager before cutover."
