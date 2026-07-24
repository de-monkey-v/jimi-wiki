#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 disconnect | connect | restore-pre-reset" >&2
  exit 2
}

action="${1:-}"
profile_command="${HERMES_PERSONAL_COMMAND:-wiki-personal}"
profile_dir="${HERMES_PERSONAL_PROFILE_DIR:-$HOME/.hermes/profiles/wiki-personal}"
profile_env="$profile_dir/.env"
profile_config="$profile_dir/config.yaml"
state_dir="${JIMI_CONFIG_DIR:-$HOME/.config/jimi-wiki}"
runtime_dir="${JIMI_RELEASE_DIR:-$HOME/.local/share/jimi-wiki/current}"
config_backup="$state_dir/hermes-personal-config.pre-reset.yaml"
key_backup="$state_dir/hermes-personal-key.pre-reset.env"

command -v "$profile_command" >/dev/null || { echo "missing Hermes personal profile command: $profile_command" >&2; exit 1; }
[[ -f "$profile_env" && -f "$profile_config" ]] || { echo "Hermes personal profile files are missing" >&2; exit 1; }
mkdir -p -m 700 "$state_dir"

server_exists() {
  "$profile_command" mcp list 2>/dev/null | grep -q 'jimi-wiki'
}

remove_profile_key() {
  local temp
  temp="$(mktemp "$profile_dir/.env.jimi-reset.XXXXXX")"
  awk '!/^JIMI_WIKI_PERSONAL_KEY=/' "$profile_env" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$profile_env"
}

case "$action" in
  disconnect)
    if server_exists; then
      install -m 0600 "$profile_config" "$config_backup"
    fi
    if grep -q '^JIMI_WIKI_PERSONAL_KEY=.' "$profile_env"; then
      umask 077
      grep '^JIMI_WIKI_PERSONAL_KEY=' "$profile_env" > "$key_backup.tmp"
      chmod 600 "$key_backup.tmp"
      mv "$key_backup.tmp" "$key_backup"
    fi
    if server_exists; then "$profile_command" mcp remove jimi-wiki; fi
    remove_profile_key
    systemctl --user restart hermes-gateway.service
    echo "Hermes personal Jimi key and MCP connection removed; profile instructions and Slack routing were not changed"
    ;;
  connect)
    [[ -f "$runtime_dir/mcp/server.mjs" ]] || { echo "missing production MCP server: $runtime_dir/mcp/server.mjs" >&2; exit 1; }
    grep -q '^JIMI_WIKI_PERSONAL_KEY=.' "$profile_env" || { echo "issue the new Hermes key before reconnecting MCP" >&2; exit 1; }
    if server_exists; then "$profile_command" mcp remove jimi-wiki; fi
    "$profile_command" mcp add jimi-wiki \
      --command /usr/bin/node \
      --connect-timeout 60 \
      --env \
        JIMI_WIKI_URL=http://127.0.0.1:3007 \
        'JIMI_WIKI_API_KEY=${JIMI_WIKI_PERSONAL_KEY}' \
        JIMI_WIKI_SLUG=personal \
      --args "$runtime_dir/mcp/server.mjs"
    systemctl --user restart hermes-gateway.service
    "$profile_command" mcp test jimi-wiki
    echo "Hermes personal Jimi MCP reconnected to the production release"
    ;;
  restore-pre-reset)
    [[ -f "$config_backup" && -f "$key_backup" ]] || { echo "pre-reset Hermes backup is missing" >&2; exit 1; }
    remove_profile_key
    printf '\n' >> "$profile_env"
    grep '^JIMI_WIKI_PERSONAL_KEY=' "$key_backup" >> "$profile_env"
    chmod 600 "$profile_env"
    install -m 0644 "$config_backup" "$profile_config"
    systemctl --user restart hermes-gateway.service
    "$profile_command" mcp test jimi-wiki
    echo "Hermes personal Jimi key and MCP config restored from the protected pre-reset backup"
    ;;
  *) usage ;;
esac
