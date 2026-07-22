#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 build <git-ref> | activate <release-dir> | rollback" >&2
  exit 2
}

command_name="${1:-}"
argument="${2:-}"
state_dir="${JIMI_STATE_DIR:-$HOME/.local/share/jimi-wiki}"
releases_dir="$state_dir/releases"
current_link="$state_dir/current"
previous_link="$state_dir/previous"
env_file="${JIMI_ENV_FILE:-$HOME/.config/jimi-wiki/app.env}"
mkdir -p -m 700 "$releases_dir" "$state_dir/shared/blobs" "$state_dir/shared/cache" "$state_dir/tmp" "$state_dir/backups"

pnpm_system() {
  env PATH=/usr/bin:/bin /usr/bin/corepack pnpm "$@"
}

case "$command_name" in
  build)
    [[ -n "$argument" ]] || usage
    repo="${JIMI_REPO:-$(git rev-parse --show-toplevel)}"
    sha="$(git -C "$repo" rev-parse --verify "${argument}^{commit}")"
    release="$releases_dir/$sha"
    if [[ -e "$release" ]]; then
      [[ -f "$release/.jimi-release" ]] || { echo "existing path is not a release: $release" >&2; exit 1; }
      echo "$release"
      exit 0
    fi
    staging="$(mktemp -d "$releases_dir/.staging-${sha:0:12}.XXXXXX")"
    trap 'rm -rf -- "$staging"' EXIT
    git -C "$repo" archive "$sha" | tar -x -C "$staging"
    (
      cd "$staging"
      # A release archive intentionally contains no .env. Prisma config still
      # requires a syntactically valid URL while generating the client, even
      # though neither generate nor Next compilation connects to the database.
      export DATABASE_URL="${DATABASE_URL:-postgresql://jimi:build-only@127.0.0.1:5433/jimi?schema=public}"
      export AUTH_SECRET="${AUTH_SECRET:-build-only-not-used-at-runtime}"
      export AUTH_MODE="${AUTH_MODE:-tailscale}"
      export APP_URL="${APP_URL:-https://build.invalid}"
      export TAILSCALE_ALLOWED_LOGIN="${TAILSCALE_ALLOWED_LOGIN:-build@example.invalid}"
      pnpm_system install --frozen-lockfile
      pnpm_system exec prisma generate
      pnpm_system build
      env PATH=/usr/bin:/bin /usr/bin/npm ci --prefix ops/codex-proxy --ignore-scripts
      printf '%s\n' "$sha" > .jimi-release
    )
    mv "$staging" "$release"
    trap - EXIT
    echo "$release"
    ;;
  activate)
    [[ -n "$argument" && -d "$argument" && -f "$argument/.jimi-release" ]] || usage
    [[ -f "$env_file" ]] || { echo "missing production env: $env_file" >&2; exit 1; }
    [[ "$(stat -c %a "$env_file")" == "600" ]] || { echo "production env must be mode 600" >&2; exit 1; }
    old_target="$(readlink -f "$current_link" 2>/dev/null || true)"
    stopped=0
    swapped=0
    recover_old() {
      if (( stopped == 1 )); then
        if (( swapped == 1 )) && [[ -n "$old_target" && -f "$old_target/.jimi-release" ]]; then
          rollback_link="$state_dir/.current.$$.rollback"
          ln -s "$old_target" "$rollback_link"
          mv -T "$rollback_link" "$current_link"
        fi
        systemctl --user daemon-reload || true
        systemctl --user restart jimi-wiki-codex-proxy.service jimi-wiki-web.service jimi-wiki-worker.service || true
      fi
    }
    trap recover_old EXIT
    systemctl --user stop jimi-wiki-worker.service jimi-wiki-web.service 2>/dev/null || true
    stopped=1
    (
      cd "$argument"
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
      pnpm_system exec prisma migrate deploy
    )
    next_link="$state_dir/.current.$$.next"
    ln -s "$argument" "$next_link"
    mv -T "$next_link" "$current_link"
    swapped=1
    if [[ -n "$old_target" && "$old_target" != "$argument" ]]; then
      previous_next="$state_dir/.previous.$$.next"
      ln -s "$old_target" "$previous_next"
      mv -T "$previous_next" "$previous_link"
    fi
    systemctl --user daemon-reload
    systemctl --user restart jimi-wiki-codex-proxy.service jimi-wiki-web.service jimi-wiki-worker.service
    stopped=0
    trap - EXIT
    echo "activated $argument"
    ;;
  rollback)
    target="$(readlink -f "$previous_link" 2>/dev/null || true)"
    [[ -n "$target" && -f "$target/.jimi-release" ]] || { echo "no previous release" >&2; exit 1; }
    "$0" activate "$target"
    echo "code rollback complete; restore DB separately if a migration was not backward-compatible"
    ;;
  *) usage ;;
esac
