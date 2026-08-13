#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 disconnect | connect | sync-skill | restore-pre-reset" >&2
  exit 2
}

action="${1:-}"
profile_command="${HERMES_PERSONAL_COMMAND:-wiki-personal}"
profile_dir="${HERMES_PERSONAL_PROFILE_DIR:-$HOME/.hermes/profiles/wiki-personal}"
profile_env="$profile_dir/.env"
profile_config="$profile_dir/config.yaml"
state_dir="${JIMI_CONFIG_DIR:-$HOME/.config/jimi-wiki}"
runtime_dir="${JIMI_RELEASE_DIR:-$HOME/releases/jimi-wiki/current}"
config_backup="$state_dir/hermes-personal-config.pre-reset.yaml"
key_backup="$state_dir/hermes-personal-key.pre-reset.env"
profile_skills_dir="$profile_dir/skills"
profile_skill_dir="$profile_skills_dir/wiki-ingest"
release_skill_dir="$runtime_dir/skills/wiki-ingest"
skill_sync_active=0
skill_sync_backup=""
skill_sync_installed=0
skill_lock_wait="${HERMES_SKILL_LOCK_WAIT:-60}"

command -v "$profile_command" >/dev/null || { echo "missing Hermes personal profile command: $profile_command" >&2; exit 1; }
[[ -f "$profile_env" && -f "$profile_config" ]] || { echo "Hermes personal profile files are missing" >&2; exit 1; }
mkdir -p -m 700 "$state_dir"
[[ "$skill_lock_wait" =~ ^[0-9]+$ ]] \
  || { echo "HERMES_SKILL_LOCK_WAIT must be a non-negative integer" >&2; exit 1; }
exec 8>"$profile_dir/.jimi-wiki-mcp.lock"
flock -w "$skill_lock_wait" 8 \
  || { echo "another Hermes Jimi MCP operation holds $profile_dir/.jimi-wiki-mcp.lock" >&2; exit 1; }

server_exists() {
  grep -q '^  jimi-wiki:$' "$profile_config"
}

server_config_matches_release() {
  local expected_server configured_server configured_server_resolved
  expected_server="$(readlink -f -- "$runtime_dir/mcp/server.mjs")" || return 1
  configured_server="$(awk '
    /^mcp_servers:$/ {
      in_mcp_servers = 1
      next
    }
    in_mcp_servers && /^[^ ]/ {
      in_mcp_servers = 0
      in_server = 0
    }
    in_mcp_servers && /^  jimi-wiki:$/ {
      in_server = 1
      found_server_block++
      section = ""
      next
    }
    in_server && /^  [^ ]/ {
      in_server = 0
      section = ""
    }
    !in_server {
      next
    }
    /^    [^ ]/ {
      section = ""
      top_level_keys++
      if ($0 == "    command: /usr/bin/node") {
        found_command++
      } else if ($0 == "    args:") {
        found_args++
        section = "args"
      } else if ($0 == "    env:") {
        found_env++
        section = "env"
      } else if ($0 ~ /^    connect_timeout: 60(\.0)?$/) {
        found_timeout++
      } else if ($0 == "    enabled: true") {
        found_enabled++
      } else {
        unexpected = 1
      }
      next
    }
    section == "args" && /^      - / {
      arg_count++
      if ($0 ~ /^      - \/[^[:space:]]+$/) {
        found_server++
        configured_server = substr($0, 9)
      } else {
        unexpected = 1
      }
      next
    }
    section == "env" && /^      [^ ]+:/ {
      env_count++
      if ($0 == "      JIMI_WIKI_URL: http://127.0.0.1:23007") {
        found_url++
      } else if ($0 == "      JIMI_WIKI_API_KEY: ${JIMI_WIKI_PERSONAL_KEY}") {
        found_key++
      } else if ($0 == "      JIMI_WIKI_SLUG: personal") {
        found_slug++
      } else {
        unexpected = 1
      }
      next
    }
    /^[[:space:]]*$/ {
      next
    }
    {
      unexpected = 1
    }
    END {
      valid = found_server_block == 1 &&
        top_level_keys == 5 &&
        found_command == 1 &&
        found_args == 1 &&
        found_env == 1 &&
        found_timeout == 1 &&
        found_enabled == 1 &&
        arg_count == 1 &&
        found_server == 1 &&
        env_count == 3 &&
        found_url == 1 &&
        found_key == 1 &&
        found_slug == 1 &&
        !unexpected
      if (valid) {
        print configured_server
      }
      exit !valid
    }
  ' "$profile_config")" || return 1
  configured_server_resolved="$(readlink -f -- "$configured_server")" || return 1
  [[ "$configured_server_resolved" == "$expected_server" ]]
}

remove_server() {
  # Hermes MCP mutations prompt even in a non-interactive shell. Feeding the
  # exact affirmative answer keeps this ops helper deterministic.
  printf 'y\n' | "$profile_command" mcp remove jimi-wiki
  if server_exists; then
    echo "Hermes personal Jimi MCP remove was not persisted" >&2
    return 1
  fi
}

verify_server() {
  local required_tool="${1:-}"
  local test_output
  server_exists || { echo "Hermes personal Jimi MCP is missing after configuration" >&2; return 1; }
  if ! test_output="$("$profile_command" mcp test jimi-wiki 2>&1)"; then
    printf '%s\n' "$test_output" >&2
    return 1
  fi
  printf '%s\n' "$test_output"
  grep -q '✓ Connected' <<<"$test_output" \
    || { echo "Hermes MCP test did not confirm a connection" >&2; return 1; }
  if [[ -n "$required_tool" ]]; then
    awk -v required_tool="$required_tool" '$1 == required_tool { found = 1 } END { exit !found }' <<<"$test_output" \
      || { echo "Hermes MCP test did not expose required tool: $required_tool" >&2; return 1; }
  fi
}

rollback_profile_skill() {
  ((skill_sync_active == 1)) || return 0
  if ((skill_sync_installed == 1)) && [[ -e "$profile_skill_dir" || -L "$profile_skill_dir" ]]; then
    rm -rf -- "$profile_skill_dir"
  fi
  if [[ -n "$skill_sync_backup" && ( -e "$skill_sync_backup" || -L "$skill_sync_backup" ) ]]; then
    mv -- "$skill_sync_backup" "$profile_skill_dir"
  fi
  skill_sync_active=0
  skill_sync_backup=""
  skill_sync_installed=0
}

commit_profile_skill() {
  local backup="$skill_sync_backup"
  skill_sync_active=0
  skill_sync_backup=""
  skill_sync_installed=0
  if [[ -n "$backup" && ( -e "$backup" || -L "$backup" ) ]]; then
    rm -rf -- "$backup"
  fi
}

stage_profile_skill() {
  [[ -f "$release_skill_dir/SKILL.md" ]] \
    || { echo "missing release wiki-ingest skill: $release_skill_dir/SKILL.md" >&2; return 1; }
  [[ -f "$release_skill_dir/references/tools.md" && -f "$release_skill_dir/references/setup.md" ]] \
    || { echo "release wiki-ingest references are incomplete: $release_skill_dir" >&2; return 1; }
  mkdir -p "$profile_skills_dir"

  local stage backup=""
  stage="$(mktemp -d "$profile_skills_dir/.wiki-ingest.next.XXXXXX")"
  if ! cp -a "$release_skill_dir/." "$stage/"; then
    rm -rf -- "$stage"
    return 1
  fi
  if [[ -e "$profile_skill_dir" || -L "$profile_skill_dir" ]]; then
    backup="$(mktemp -d "$profile_skills_dir/.wiki-ingest.previous.XXXXXX")"
    rmdir "$backup"
    skill_sync_active=1
    skill_sync_backup="$backup"
    if ! mv -- "$profile_skill_dir" "$backup"; then
      skill_sync_active=0
      skill_sync_backup=""
      rm -rf -- "$stage"
      return 1
    fi
  else
    skill_sync_active=1
  fi

  skill_sync_installed=1
  if ! mv -- "$stage" "$profile_skill_dir"; then
    rollback_profile_skill
    rm -rf -- "$stage"
    return 1
  fi
}

sync_skill_and_gateway() {
  local start_if_inactive="${1:-0}" gateway_state=0 gateway_was_active=0 reload_gateway=0 required_tool=""
  server_config_matches_release \
    || { echo "Hermes personal Jimi MCP does not resolve to $runtime_dir/mcp/server.mjs" >&2; return 1; }
  if grep -q 'record_research_report' "$release_skill_dir/SKILL.md"; then
    required_tool="record_research_report"
  fi
  if systemctl --user is-active --quiet hermes-gateway.service; then
    gateway_was_active=1
  else
    gateway_state=$?
    if ((gateway_state != 3 && gateway_state != 4)); then
      echo "could not determine hermes-gateway.service state (exit $gateway_state)" >&2
      return 1
    fi
  fi
  if ((gateway_was_active == 1 || start_if_inactive == 1)); then
    reload_gateway=1
  fi

  stage_profile_skill || return 1
  if ((reload_gateway == 1)) && ! systemctl --user restart hermes-gateway.service; then
    rollback_profile_skill
    if ((gateway_was_active == 1)); then
      systemctl --user restart hermes-gateway.service || true
    else
      systemctl --user stop hermes-gateway.service || true
    fi
    return 1
  fi
  if ((reload_gateway == 1)) && ! systemctl --user is-active --quiet hermes-gateway.service; then
    rollback_profile_skill
    if ((gateway_was_active == 1)); then
      systemctl --user restart hermes-gateway.service || true
    else
      systemctl --user stop hermes-gateway.service || true
    fi
    return 1
  fi
  if ! verify_server "$required_tool"; then
    rollback_profile_skill
    if ((gateway_was_active == 1)); then
      systemctl --user restart hermes-gateway.service || true
    elif ((reload_gateway == 1)); then
      systemctl --user stop hermes-gateway.service || true
    fi
    return 1
  fi
  commit_profile_skill
  echo "Hermes wiki-ingest skill synchronized from $runtime_dir"
}

trap 'rollback_profile_skill' EXIT

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
    if server_exists; then remove_server; fi
    remove_profile_key
    systemctl --user restart hermes-gateway.service
    echo "Hermes personal Jimi key and MCP connection removed; profile instructions and Slack routing were not changed"
    ;;
  connect)
    [[ -f "$runtime_dir/mcp/server.mjs" ]] || { echo "missing production MCP server: $runtime_dir/mcp/server.mjs" >&2; exit 1; }
    grep -q '^JIMI_WIKI_PERSONAL_KEY=.' "$profile_env" || { echo "issue the new Hermes key before reconnecting MCP" >&2; exit 1; }
    if server_exists; then remove_server; fi
    printf 'y\n' | "$profile_command" mcp add jimi-wiki \
      --command /usr/bin/node \
      --connect-timeout 60 \
      --env \
        JIMI_WIKI_URL=http://127.0.0.1:23007 \
        'JIMI_WIKI_API_KEY=${JIMI_WIKI_PERSONAL_KEY}' \
        JIMI_WIKI_SLUG=personal \
      --args "$runtime_dir/mcp/server.mjs"
    server_exists || { echo "Hermes personal Jimi MCP add was not persisted" >&2; exit 1; }
    server_config_matches_release \
      || { echo "Hermes personal Jimi MCP does not match the production release configuration" >&2; exit 1; }
    sync_skill_and_gateway 1
    echo "Hermes personal Jimi MCP reconnected to the production release"
    ;;
  sync-skill)
    server_exists || { echo "Hermes personal Jimi MCP is not configured" >&2; exit 1; }
    sync_skill_and_gateway 0
    ;;
  restore-pre-reset)
    [[ -f "$config_backup" && -f "$key_backup" ]] || { echo "pre-reset Hermes backup is missing" >&2; exit 1; }
    remove_profile_key
    printf '\n' >> "$profile_env"
    grep '^JIMI_WIKI_PERSONAL_KEY=' "$key_backup" >> "$profile_env"
    chmod 600 "$profile_env"
    install -m 0644 "$config_backup" "$profile_config"
    sync_skill_and_gateway 1
    echo "Hermes personal Jimi key and MCP config restored from the protected pre-reset backup"
    ;;
  *) usage ;;
esac
