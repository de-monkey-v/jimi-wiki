---
name: release-jimi-wiki
description: Promote and deploy a Jimi Wiki production release through version bump, develop push, main fast-forward, annotated tag push, immutable build, activation, runtime identity checks, health checks, and change-specific smoke verification. Use when the user asks to release, deploy, promote, publish, activate, or roll out jimi-wiki, says "릴리스 반영해줘" or "운영에 올려줘", or asks why a pushed change is not visible in the running site. Do not use for ordinary development pushes, local setup, or rollback-only requests.
---

# Release Jimi Wiki

Treat a release as one ordered transaction with independently checked
postconditions. Use `docs/personal-production.md` and `ops/deploy.sh` as the
source of truth; this skill prevents orchestration steps from being omitted.

Do not use `release-refresh` for Jimi Wiki. Its runtime root is an
application-owned immutable archive tree, not a registered Git release
checkout.

## Establish authority and target

Proceed only when the user explicitly asks for an operating release. A commit,
push, or merge request does not authorize deployment.

Choose an exact `vX.Y.Z` tag. Default to the next patch only for a compatible
change; ask for the intended version when a minor/major boundary is plausible.
Never reuse, move, delete, or force-push an existing release tag.

Read the release and rollback sections of `docs/personal-production.md`. Run
all Git commands from the repository root. Stop if the source checkout is
dirty, a Git operation is in progress, or another session owns overlapping
changes.

Fetch before judging local state:

```bash
git fetch --prune --tags origin develop main
```

Capture the running release before changing anything:

```bash
skill_dir=".agents/skills/release-jimi-wiki"
before_snapshot="$(mktemp /tmp/jimi-release-before.XXXXXX.json)"
python3 "$skill_dir/scripts/release_status.py" --phase current --json \
  > "$before_snapshot"
```

Stop on a nonzero result. Keep the snapshot until post-activation identity is
verified. Record the old release SHA/tag and all three service PIDs.

## Prepare the release commit on develop

Use the normal `dev` and `wt` workflow for the version edit. Change only
`package.json` unless the repository contract later requires another version
file. Commit with:

```text
chore(release): vX.Y.Z

What
- package.json 버전을 X.Y.Z로 올린다

Why
- 검증된 변경을 immutable version tag로 승격하고 운영 배포 조건을 충족하기 위해서다
```

Run the checks required by `CONTRIBUTING.md` for the candidate. Then push the
release commit to `develop`; this push is mandatory and happens before
promotion:

```bash
git push origin develop
git fetch --prune --tags origin develop main
python3 "$skill_dir/scripts/release_status.py" --phase prepared --tag "$tag"
```

`prepared` must prove all of these before continuing: clean `develop`, exact
`origin/develop`, matching `package.json` version, unchanged and synchronized
`main`, fast-forwardability, and absence of the target tag locally and remotely.

## Promote and push main plus tag

Run the sequence without reordering:

```bash
git switch main
git pull --ff-only origin main
git merge --ff-only develop
git tag -a "$tag" -m "$tag"
git push --atomic origin main "$tag"
git switch develop
git fetch --prune --tags origin develop main
python3 "$skill_dir/scripts/release_status.py" --phase promoted --tag "$tag"
```

Do not fall back to a non-atomic or force push silently. If any command fails,
stop at that phase and report which refs exist locally and remotely. Do not
retag automatically.

`promoted` must prove the annotated tag, local/remote tag object, peeled commit,
`main`, `origin/main`, `develop`, and `origin/develop` all identify the same
release commit, and that the tag matches `package.json`.

## Classify release-sensitive changes

Compare the previously active SHA with the target SHA before activation:

```bash
old_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshot"]["release_sha"])' "$before_snapshot")"
target_sha="$(git rev-parse "$tag^{commit}")"
git diff --name-only "$old_sha..$target_sha"
```

Apply these conditional gates:

- `prisma/migrations/**`: let `ops/deploy.sh activate` perform the mandatory
  pre-migration backup and `migrate deploy`. Never set
  `JIMI_SKIP_MIGRATION_BACKUP=1` in routine work.
- `ops/systemd/**` or `ops/install-systemd.sh`: run the target release's
  `ops/install-systemd.sh` before activation, then verify the installed units.
- `docker-compose.production.yml`, `ops/compose.sh`, production port/env, or
  container policy changes: stop and derive an explicit container/config
  migration plan. Never run bare `docker compose`; use `ops/compose.sh` only.
- `ops/prepare-env.sh` or required environment keys: stop and update the
  owner-only production env deliberately. Never print or overwrite secrets.
- authentication, account reset, Tailscale policy, or Hermes key changes:
  follow their dedicated runbook sections and obtain any additional authority
  before external control-plane or credential mutations.

## Build the immutable release

Build only the pushed version tag:

```bash
build_output="$(ops/deploy.sh build "$tag")" || {
  printf '%s\n' "$build_output"
  exit 1
}
printf '%s\n' "$build_output"
release="$(printf '%s\n' "$build_output" | tail -n 1)"
python3 "$skill_dir/scripts/release_status.py" --phase built --tag "$tag"
target_sha="$(git rev-parse "$tag^{commit}")"
expected_release="${JIMI_STATE_DIR:-$HOME/releases/jimi-wiki}/releases/$target_sha"
[[ "$(readlink -f "$release")" == "$(readlink -f "$expected_release")" ]] || {
  echo "build returned an unexpected release path: $release" >&2
  exit 1
}
release="$(readlink -f "$release")"
```

Never build a branch, bare SHA, dirty tree, or an unpushed tag. Do not set
`JIMI_SKIP_REMOTE_CHECK=1` in routine work. `built` must verify `.jimi-release`,
`.jimi-tag`, the Next build, and the pinned Codex proxy artifact under the exact
`~/releases/jimi-wiki/releases/<sha>` directory.

Do not rerun first-install actions (`ops/prepare-env.sh`, account reset, blob
copy, password rotation, or initial Tailscale setup) during an ordinary release
unless the classified diff explicitly requires them.

## Activate exactly what was built

Activate the path returned by the build command, never a reconstructed or
hand-typed alternate path:

```bash
activation_snapshot="$(mktemp /tmp/jimi-release-activate.XXXXXX.json)"
python3 "$skill_dir/scripts/release_status.py" --phase current --json \
  > "$activation_snapshot"
python3 - "$before_snapshot" "$activation_snapshot" <<'PY'
import json
import sys

initial = json.load(open(sys.argv[1], encoding="utf-8"))["snapshot"]["release_sha"]
current = json.load(open(sys.argv[2], encoding="utf-8"))["snapshot"]["release_sha"]
if initial != current:
    raise SystemExit(f"active release changed during preparation: {initial} -> {current}")
PY
ops/deploy.sh activate "$release"
```

The second snapshot narrows the build-time race and becomes the PID baseline
for post-activation checks. If the active SHA changed, stop and repeat change
classification against the new baseline instead of deploying over it. The
`active` checkpoint also binds that snapshot to this repository, this state
directory, the immutable old-release metadata, and the post-activation
`previous` symlink; an arbitrary or stale JSON file is not a valid baseline.

Activation owns container provenance checks, migration backup, migration,
atomic `current` swap, service restart, readiness waiting, and automatic
recovery to the old release when readiness fails. Stop immediately on failure;
do not claim success merely because build or push succeeded.

## Verify runtime identity and behavior

First prove that the active release and processes changed:

```bash
python3 "$skill_dir/scripts/release_status.py" --phase active --tag "$tag" \
  --previous-snapshot "$activation_snapshot"
```

Then run the complete health audit with the production environment loaded
without printing it:

```bash
set -a
source "$HOME/.config/jimi-wiki/app.env"
set +a
"$release/ops/health-check.sh"
```

If `service-audit` is available, run it as an additional run-from check. It does
not replace `release_status.py` or `health-check.sh`.

Finally rerun at least one change-specific black-box journey against the actual
production URL. Reuse the independent acceptance criterion from the feature
work: for a UI change, drive the visible interaction; for an API change, call
the authenticated endpoint and observe its payload; for a worker change,
observe a real queued job. Readiness alone is not feature verification.

Remove both temporary snapshots only after all verification is recorded.
Prefer the system trash when available.

## Fail closed and report the exact phase

- Before tag push: leave refs untouched and fix the release commit or state.
- After tag push but before activation: report "promoted, not active" with the
  tag and SHA. Do not imply deployment.
- If `activate` fails: it attempts recovery itself. Re-run `--phase current` and
  report the release and PIDs actually serving.
- If full health or the change-specific journey fails after activation: do not
  claim completion and do not hide the failure. Do not invoke rollback without
  considering migration compatibility and the user's authority.

A completion report must include every item below:

- version tag and release SHA;
- exact `origin/develop` and `origin/main` SHA;
- remote annotated tag confirmation;
- immutable release directory;
- `current` symlink target;
- old and new PID for web, worker, and Codex proxy;
- readiness and full health result;
- change-specific production observation;
- whether migrations, systemd, containers, env, auth, or Hermes required a
  conditional action;
- rollback target and any remaining gap.

If any item is unknown, say which phase is incomplete instead of saying the
release is done.
