#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 build <version-tag> | activate <release-dir> | rollback | prune [--dry-run]" >&2
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

config_dir="${JIMI_CONFIG_DIR:-$HOME/.config/jimi-wiki}"
actions_key_file="${JIMI_ACTIONS_KEY_FILE:-$config_dir/server-actions-key}"
db_container="${JIMI_DB_CONTAINER:-jimi-wiki-db}"
db_user="${JIMI_DB_USER:-jimi}"
db_name="${JIMI_DB_NAME:-jimi}"

# 릴리스가 선언한 마이그레이션에서 운영 DB에 이미 적용된 것을 뺀 목록을 출력한다.
# `prisma migrate status` 출력 파싱은 Prisma 버전에 종속이라 쓰지 않는다.
# DB 접속은 backup.sh와 같은 docker exec 방식이다 — 컨테이너 안은 로컬 trust라
# 회전된 운영 비밀번호를 다룰 필요가 없다.
release_pending_migrations() {
  local release_dir="$1"
  local declared applied
  declared="$(find "$release_dir/prisma/migrations" -mindepth 2 -maxdepth 2 -name migration.sql \
    -printf '%h\n' 2>/dev/null | sed 's#.*/##' | LC_ALL=C sort)"
  [[ -n "$declared" ]] || return 0
  # DB가 죽었거나 _prisma_migrations가 없으면 applied가 비어 전량 pending으로 판정된다.
  # 그러면 백업이 강제되고, 백업까지 실패하면 activate가 중단된다 = fail-closed.
  applied="$(docker exec "$db_container" psql -U "$db_user" -d "$db_name" -Atc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" \
    2>/dev/null | LC_ALL=C sort)"
  if [[ -z "$applied" ]]; then
    printf '%s\n' "$declared"
    return 0
  fi
  printf '%s\n' "$declared" | grep -Fxv -f <(printf '%s\n' "$applied") || true
}

# 배포는 한 번에 하나만 돈다. activate 도중 다른 activate가 끼어들면 심링크 교체와
# 마이그레이션이 뒤섞이고, prune이 그 사이에 돌면 준비 중인 릴리스를 지울 수 있다.
state_lock() {
  exec 9>"$state_dir/deploy.lock"
  flock -w "${JIMI_LOCK_WAIT:-600}" 9 \
    || { echo "another deploy holds $state_dir/deploy.lock" >&2; exit 1; }
}

# 락을 이 호출 동안만 잡는다. build는 몇 분씩 걸리므로 전 구간을 잠그면 그동안
# activate가 막힌다. 락 없이 두면 build의 사전 정리가, 마침 진행 중인 activate가
# 켜려는 오래된 릴리스를 지울 수 있다.
prune_locked() {
  (
    exec 9>"$state_dir/deploy.lock"
    flock -w "${JIMI_LOCK_WAIT:-600}" 9 || exit 1
    prune_releases "$@"
  )
}

# 실행 중 프로세스가 물고 있는 릴리스. 재시작에 실패해 옛 릴리스로 계속 도는 프로세스가
# 있으면 그 디렉터리를 지워선 안 된다 — 당장은 살아 있지만 다음 lazy import나 정적 파일
# 읽기에서 죽고, 원인을 추적하기가 매우 어렵다.
in_use_releases() {
  local link target rest
  for link in /proc/[0-9]*/cwd /proc/[0-9]*/exe; do
    target="$(readlink -f "$link" 2>/dev/null)" || continue
    [[ "$target" == "$releases_dir"/* ]] || continue
    rest="${target#"$releases_dir"/}"
    printf '%s\n' "$releases_dir/${rest%%/*}"
  done
}

# 보존: 최근 keep개 또는 keep_days일 이내 중 넓은 쪽. current·previous·사용 중은 무조건 보호.
prune_releases() {
  local dry_run="${1:-}"
  local keep="${JIMI_KEEP:-3}" keep_days="${JIMI_KEEP_DAYS:-14}"
  # 잘못된 값은 조용히 다르게 동작한다 — `head -n 0`은 SIGPIPE로, `-n -1`은 "마지막
  # 하나만 빼고"로 해석돼 보존 범위가 뜻과 어긋난다. 정리 전에 막는다.
  [[ "$keep" =~ ^[0-9]+$ && "$keep_days" =~ ^[0-9]+$ ]] || {
    echo "JIMI_KEEP/JIMI_KEEP_DAYS must be non-negative integers (got '$keep' / '$keep_days')" >&2
    return 1
  }
  local protected release age
  protected="$(
    { readlink -f "$current_link" 2>/dev/null || true
      readlink -f "$previous_link" 2>/dev/null || true
      in_use_releases
      # 최근 keep개는 mtime 기준으로 남긴다. keep=0이면 개수 보호를 쓰지 않겠다는
      # 뜻인데, `head -n 0`은 SIGPIPE를 내고 pipefail과 겹쳐 정리 자체가 죽는다.
      if ((keep > 0)); then
        find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' \
          -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n "$keep" | cut -d' ' -f2-
      fi
    } | sort -u
  )"
  while IFS= read -r release; do
    [[ -n "$release" ]] || continue
    grep -qxF "$release" <<<"$protected" && continue
    # keep_days 이내면 남긴다 — 롤백 창을 개수만으로 좁히지 않는다.
    age="$(find "$release" -maxdepth 0 -mtime "+$keep_days" -print 2>/dev/null)"
    [[ -n "$age" ]] || continue
    if [[ "$dry_run" == "--dry-run" ]]; then
      echo "would remove $release"
    else
      echo "removing $release"
      rm -rf -- "$release"
    fi
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | sort)

  # 죽은 build가 남긴 staging. 진행 중인 build를 지우지 않도록 하루 지난 것만 건드린다.
  while IFS= read -r stale; do
    [[ -n "$stale" ]] || continue
    if [[ "$dry_run" == "--dry-run" ]]; then
      echo "would remove $stale"
    else
      echo "removing $stale"
      rm -rf -- "$stale"
    fi
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -name '.staging-*' -mtime +1 2>/dev/null)
}

# 재시작이 실제로 떴는지 확인한다. 전체 health-check.sh는 funnel·키 만료처럼 이 릴리스와
# 무관한 항목까지 보므로 게이트로 쓰면 멀쩡한 배포가 남의 사정으로 롤백된다.
wait_ready() {
  local deadline=$((SECONDS + ${JIMI_READY_TIMEOUT:-120}))
  local web="${JIMI_READY_URL:-http://127.0.0.1:23007/api/readyz}"
  local proxy="${JIMI_PROXY_READY_URL:-http://127.0.0.1:10531/v1/models}"
  while ((SECONDS < deadline)); do
    if curl --fail --silent --max-time 5 "$web" >/dev/null 2>&1 \
      && curl --fail --silent --max-time 5 "$proxy" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

case "$command_name" in
  build)
    [[ -n "$argument" ]] || usage
    repo="${JIMI_REPO:-$(git rev-parse --show-toplevel)}"
    # 배포 대상은 push된 vX.Y.Z 태그뿐이다. develop 커밋을 직접 배포하면 개발과 릴리스가
    # 다시 결합되고, 커밋 하나당 배포 하나가 되어 릴리스가 개발 속도에 묶인다.
    [[ "$argument" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || { echo "release ref must be a version tag (vX.Y.Z): $argument" >&2; exit 1; }
    git -C "$repo" rev-parse --verify --quiet "refs/tags/$argument" >/dev/null \
      || { echo "no such git tag: $argument" >&2; exit 1; }
    sha="$(git -C "$repo" rev-parse --verify "refs/tags/$argument^{commit}")"
    git -C "$repo" merge-base --is-ancestor "$sha" refs/heads/main \
      || { echo "$argument is not reachable from main; ff-merge develop into main first" >&2; exit 1; }
    # 태그명과 릴리스 커밋의 package.json version이 어긋난 릴리스는 애초에 만들 수 없게 한다.
    tag_version="$(git -C "$repo" show "$sha:package.json" | /usr/bin/node -e \
      'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(String(JSON.parse(s).version ?? "")))')"
    [[ "$argument" == "v$tag_version" ]] \
      || { echo "tag $argument does not match package.json version '$tag_version' at ${sha:0:12}" >&2; exit 1; }
    if [[ "${JIMI_SKIP_REMOTE_CHECK:-0}" != "1" ]]; then
      # 태그를 push하면 그 커밋 객체도 origin에 존재하게 된다 = 이 호스트가 죽어도 릴리스를 재현할 수 있다.
      # annotated 태그는 refs/tags/X와 peel된 refs/tags/X^{} 두 줄로 오므로 peel 쪽을 우선한다.
      remote_sha="$(git -C "$repo" ls-remote --tags origin \
        | awk -v t="refs/tags/$argument" '$2 == t { plain = $1 } $2 == t "^{}" { peeled = $1 } END { print (peeled != "" ? peeled : plain) }')"
      [[ "$remote_sha" == "$sha" ]] \
        || { echo "tag $argument is not pushed to origin (remote: ${remote_sha:-none})" >&2; exit 1; }
    fi
    release="$releases_dir/$sha"
    if [[ -e "$release" ]]; then
      [[ -f "$release/.jimi-release" ]] || { echo "existing path is not a release: $release" >&2; exit 1; }
      printf '%s\n' "$argument" > "$release/.jimi-tag"
      echo "$release"
      exit 0
    fi
    # Server Action ID 해시의 salt(NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)를 릴리스 간 고정한다.
    # 이 키가 빌드마다 랜덤이면 소스가 한 글자도 안 바뀐 액션까지 ID가 전부 달라져서
    # (실측: 연속 두 릴리스 간 공통 0/75) 배포 순간 열려 있던 탭의 폴링이 즉시 죽는다.
    if [[ ! -f "$actions_key_file" ]]; then
      mkdir -p -m 700 "$config_dir"
      ( umask 077; openssl rand -base64 32 > "$actions_key_file" )
    fi
    chmod 600 "$actions_key_file"
    actions_key="$(cat "$actions_key_file")"
    # 빌드 전에 공간을 확보한다. 여기서 디스크가 차면 빌드 실패로 끝나지 않고 같은
    # 디스크의 Postgres write까지 함께 실패한다.
    prune_locked || true
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
      # 변경되지 않은 파일의 Server Action ID를 릴리스를 넘어 보존한다(위 키 생성부 참고).
      # 시그니처가 바뀐 액션은 여전히 ID가 달라지므로, 클라이언트의 스큐 안내가 안전망으로 남는다.
      export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$actions_key"
      pnpm_system install --frozen-lockfile
      pnpm_system exec prisma generate
      pnpm_system build
      env PATH=/usr/bin:/bin /usr/bin/npm ci --prefix ops/codex-proxy --ignore-scripts
      printf '%s\n' "$sha" > .jimi-release
      printf '%s\n' "$argument" > .jimi-tag
    )
    mv "$staging" "$release"
    trap - EXIT
    echo "$release"
    ;;
  activate)
    [[ -n "$argument" && -d "$argument" && -f "$argument/.jimi-release" ]] || usage
    state_lock
    [[ -f "$env_file" ]] || { echo "missing production env: $env_file" >&2; exit 1; }
    [[ "$(stat -c %a "$env_file")" == "600" ]] || { echo "production env must be mode 600" >&2; exit 1; }
    # 서비스를 멈추기 전에, 지금 떠 있는 운영 컨테이너가 정말 운영 설정에서 나왔는지 본다.
    # 개발 compose로 뜬 DB에 대고 배포하면 마이그레이션이 엉뚱한 설정의 컨테이너에 적용된다.
    if [[ "${JIMI_SKIP_CONTAINER_CHECK:-0}" != "1" ]]; then
      "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/check-production-containers.sh"
    fi
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
    # 이 릴리스에 아직 운영 DB에 없는 마이그레이션이 있으면 적용 직전 스냅샷을 강제로 남긴다.
    # rollback은 심링크만 되돌리고 스키마는 되돌리지 못하므로(아래 rollback 안내 참고),
    # 되돌릴 수 없는 변경 직전의 백업이 유일한 복구 수단이다.
    #
    # web/worker는 바로 위에서 이미 정지됐다 — backup.sh는 is-active를 먼저 확인한 뒤에만
    # 멈추고 자기가 멈춘 것만 되살리므로, 이중 정지도 없고 암호화·복제 동안 writer가
    # 되살아나지도 않는다(= 스냅샷이 마이그레이션 직전 상태와 정확히 일치한다).
    # 백업이 실패하면 set -e로 activate가 중단되고 recover_old가 이전 릴리스를 그대로 되살린다.
    pending_migrations="$(release_pending_migrations "$argument")"
    if [[ -z "$pending_migrations" ]]; then
      echo "no pending migrations; skipping the pre-migration backup"
    else
      echo "pending migrations:" >&2
      sed 's/^/  /' <<<"$pending_migrations" >&2
      if [[ "${JIMI_SKIP_MIGRATION_BACKUP:-0}" == "1" ]]; then
        echo "JIMI_SKIP_MIGRATION_BACKUP=1: skipping the pre-migration backup" >&2
      elif [[ -L "$current_link" && ! -e "$current_link" ]]; then
        # 심링크는 있는데 대상 릴리스가 사라졌다 = 상태 디렉터리 손상.
        # 이걸 "최초 cutover"와 같이 취급해 그냥 넘기면 되돌릴 수 없는 마이그레이션이
        # 스냅샷 없이 적용된다. 사람이 상태를 고치도록 배포를 멈춘다.
        echo "current release symlink is dangling ($current_link); refusing to migrate without a backup" >&2
        exit 1
      elif [[ ! -d "$current_link" ]]; then
        # 최초 cutover에만 해당한다: 되돌릴 릴리스도, backup.sh의 runtime_dir도 아직 없다.
        echo "no current release yet; skipping the pre-migration backup" >&2
      else
        "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/backup.sh"
      fi
    fi
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
    # 여기서 실패하면 stopped/swapped가 아직 1이므로 recover_old가 이전 릴리스를 되살린다.
    # 재시작만 하고 끝내면 "배포 성공"이라고 말한 뒤 서비스가 죽어 있는 상태가 남는다.
    wait_ready || { echo "release did not become ready in time; rolling back" >&2; exit 1; }
    stopped=0
    trap - EXIT
    echo "activated $argument"
    prune_releases || true
    ;;
  prune)
    state_lock
    prune_releases "${argument:-}"
    ;;
  rollback)
    target="$(readlink -f "$previous_link" 2>/dev/null || true)"
    [[ -n "$target" && -f "$target/.jimi-release" ]] || { echo "no previous release" >&2; exit 1; }
    "$0" activate "$target"
    echo "code rollback complete; restore DB separately if a migration was not backward-compatible"
    ;;
  *) usage ;;
esac
