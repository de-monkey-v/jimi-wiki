#!/usr/bin/env python3
"""Read-only checkpoint verifier for the Jimi Wiki release workflow."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


TAG_PATTERN = re.compile(r"^v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)$")
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
ATTESTATION_DOMAIN = b"jimi-wiki-release-snapshot-v1"
UNITS = (
    "jimi-wiki-web.service",
    "jimi-wiki-worker.service",
    "jimi-wiki-codex-proxy.service",
)
READY_URLS = (
    ("runtime.web-ready", os.environ.get("JIMI_READY_URL", "http://127.0.0.1:23007/api/readyz")),
    ("runtime.proxy-ready", os.environ.get("JIMI_PROXY_READY_URL", "http://127.0.0.1:10531/v1/models")),
)


@dataclass(frozen=True)
class Check:
    code: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def run_command(argv: Iterable[str], *, cwd: Path | None = None, timeout: int = 15) -> CommandResult:
    try:
        result = subprocess.run(
            list(argv),
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return CommandResult(result.returncode, result.stdout.strip(), result.stderr.strip())
    except (OSError, subprocess.TimeoutExpired) as error:
        return CommandResult(124, "", str(error))


def git(repo: Path, *args: str) -> CommandResult:
    return run_command(("git", "-C", str(repo), *args))


def rev_parse(repo: Path, revision: str) -> str | None:
    result = git(repo, "rev-parse", "--verify", revision)
    return result.stdout if result.returncode == 0 else None


def remote_refs(repo: Path, *patterns: str) -> tuple[dict[str, str], str | None]:
    result = git(repo, "ls-remote", "origin", *patterns)
    if result.returncode != 0:
        return {}, result.stderr or "git ls-remote failed"
    refs: dict[str, str] = {}
    for line in result.stdout.splitlines():
        fields = line.split("\t", 1)
        if len(fields) == 2:
            refs[fields[1]] = fields[0]
    return refs, None


def package_version(repo: Path, revision: str) -> tuple[str | None, str | None]:
    result = git(repo, "show", f"{revision}:package.json")
    if result.returncode != 0:
        return None, result.stderr or f"cannot read package.json at {revision}"
    try:
        package = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return None, f"invalid package.json at {revision}: {error}"
    if not isinstance(package, dict):
        return None, f"package.json at {revision} is not an object"
    value = package.get("version")
    return (value, None) if isinstance(value, str) else (None, "package.json version is not a string")


def add(checks: list[Check], code: str, ok: bool, detail: str) -> None:
    checks.append(Check(code=code, ok=bool(ok), detail=detail))


def inside(path: Path | None, root: Path) -> bool:
    if path is None:
        return False
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def load_attestation_key(path: Path) -> tuple[bytes | None, str | None]:
    try:
        if path.is_symlink() or not path.is_file():
            return None, f"snapshot attestation key is not a regular file: {path}"
        mode = path.stat().st_mode & 0o777
        if mode != 0o600:
            return None, f"snapshot attestation key must be mode 600 (got {mode:o}): {path}"
        raw = path.read_bytes()
    except OSError as error:
        return None, str(error)
    if not raw:
        return None, f"snapshot attestation key is empty: {path}"
    return hmac.new(raw, ATTESTATION_DOMAIN, hashlib.sha256).digest(), None


def snapshot_digest(payload: dict[str, Any], key: bytes) -> str:
    unsigned = {name: value for name, value in payload.items() if name != "attestation"}
    canonical = json.dumps(
        unsigned,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hmac.new(key, canonical, hashlib.sha256).hexdigest()


def attest_snapshot(payload: dict[str, Any], key: bytes) -> None:
    payload["attestation"] = {
        "algorithm": "hmac-sha256",
        "digest": snapshot_digest(payload, key),
    }


def verify_snapshot_attestation(payload: dict[str, Any], key: bytes | None) -> bool:
    attestation = payload.get("attestation")
    if key is None or not isinstance(attestation, dict):
        return False
    digest = attestation.get("digest")
    return (
        attestation.get("algorithm") == "hmac-sha256"
        and isinstance(digest, str)
        and hmac.compare_digest(digest, snapshot_digest(payload, key))
    )


def unit_state(unit: str) -> dict[str, Any]:
    result = run_command(
        (
            "systemctl",
            "--user",
            "show",
            unit,
            "--property=ActiveState",
            "--property=SubState",
            "--property=MainPID",
        ),
        timeout=10,
    )
    values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    try:
        pid = int(values.get("MainPID", "0"))
    except ValueError:
        pid = 0
    cwd: Path | None = None
    if pid > 0:
        try:
            cwd = Path(f"/proc/{pid}/cwd").resolve(strict=True)
        except OSError:
            cwd = None
    return {
        "unit": unit,
        "command_ok": result.returncode == 0,
        "active": values.get("ActiveState"),
        "sub": values.get("SubState"),
        "pid": pid,
        "cwd": str(cwd) if cwd else None,
        "error": result.stderr or None,
    }


def probe(url: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            status = int(response.status)
        return 200 <= status < 300, f"HTTP {status} {url}"
    except (OSError, TypeError, ValueError, urllib.error.URLError) as error:
        return False, f"{url}: {error}"


def validate_previous_snapshot(
    snapshot: dict[str, Any] | None,
    *,
    target_sha: str | None,
    current_units: dict[str, dict[str, Any]],
    repo: Path,
    state_dir: Path,
    attestation_key: bytes | None,
) -> list[Check]:
    checks: list[Check] = []
    valid = (
        isinstance(snapshot, dict)
        and snapshot.get("schema_version") == 1
        and snapshot.get("phase") == "current"
        and snapshot.get("ok") is True
    )
    add(checks, "previous.snapshot", valid, "schema=1 phase=current ok=true required")
    if not valid:
        return checks
    add(
        checks,
        "previous.attestation",
        verify_snapshot_attestation(snapshot, attestation_key),
        "valid HMAC from the owner-only snapshot key required",
    )
    add(
        checks,
        "previous.repo",
        snapshot.get("repo") == str(repo),
        f"snapshot={snapshot.get('repo') or 'missing'} expected={repo}",
    )
    add(
        checks,
        "previous.state-dir",
        snapshot.get("state_dir") == str(state_dir),
        f"snapshot={snapshot.get('state_dir') or 'missing'} expected={state_dir}",
    )
    previous = snapshot.get("snapshot") if isinstance(snapshot.get("snapshot"), dict) else {}
    previous_sha = previous.get("release_sha")
    previous_tag = previous.get("release_tag")
    previous_release_value = previous.get("release_dir")
    sha_valid = isinstance(previous_sha, str) and bool(SHA_PATTERN.fullmatch(previous_sha))
    add(
        checks,
        "previous.release",
        sha_valid and bool(target_sha) and previous_sha != target_sha,
        f"old={previous_sha or 'missing'} target={target_sha or 'missing'}",
    )
    expected_release = state_dir / "releases" / previous_sha if sha_valid else None
    previous_release: Path | None = None
    if isinstance(previous_release_value, str):
        try:
            previous_release = Path(previous_release_value).resolve(strict=True)
        except OSError:
            pass
    artifact_ok = bool(
        expected_release
        and previous_release
        and previous_release_value == str(previous_release)
        and previous_release == expected_release.resolve()
        and expected_release.is_dir()
        and not expected_release.is_symlink()
        and read_text(expected_release / ".jimi-release") == previous_sha
        and isinstance(previous_tag, str)
        and bool(TAG_PATTERN.fullmatch(previous_tag))
        and read_text(expected_release / ".jimi-tag") == previous_tag
    )
    add(
        checks,
        "previous.release-artifact",
        artifact_ok,
        (
            f"snapshot={previous_release_value or 'missing'} "
            f"expected={expected_release or 'missing'} tag={previous_tag or 'missing'}"
        ),
    )
    previous_link = state_dir / "previous"
    previous_target: Path | None = None
    try:
        previous_target = previous_link.resolve(strict=True)
    except OSError:
        pass
    add(
        checks,
        "previous.symlink",
        previous_link.is_symlink()
        and bool(previous_target and previous_release)
        and previous_target == previous_release,
        f"previous={previous_target or 'missing'} snapshot={previous_release or 'missing'}",
    )
    previous_pids = previous.get("pids") if isinstance(previous.get("pids"), dict) else {}
    for unit in UNITS:
        old_pid = previous_pids.get(unit)
        new_pid = current_units.get(unit, {}).get("pid")
        changed = type(old_pid) is int and old_pid > 0 and type(new_pid) is int and new_pid > 0 and old_pid != new_pid
        add(checks, f"pid.changed.{unit}", changed, f"old={old_pid or 0} new={new_pid or 0}")
    return checks


class Inspector:
    def __init__(self, repo: Path, state_dir: Path, tag: str | None):
        self.repo = repo
        self.state_dir = state_dir
        self.tag = tag
        self.checks: list[Check] = []
        self.snapshot: dict[str, Any] = {}

    def common_repo(self) -> tuple[str | None, str | None, dict[str, str]]:
        status = git(self.repo, "status", "--porcelain=v1", "--untracked-files=all")
        add(self.checks, "repo.clean", status.returncode == 0 and not status.stdout, status.stdout or status.stderr or "clean")
        branch = git(self.repo, "branch", "--show-current")
        add(self.checks, "repo.branch", branch.returncode == 0 and branch.stdout == "develop", branch.stdout or branch.stderr or "detached")
        head = rev_parse(self.repo, "HEAD")
        develop = rev_parse(self.repo, "refs/heads/develop")
        add(self.checks, "develop.head", bool(head) and head == develop, f"HEAD={head or 'missing'} develop={develop or 'missing'}")
        refs, error = remote_refs(self.repo, "refs/heads/develop", "refs/heads/main")
        add(self.checks, "origin.reachable", error is None, error or "origin refs read")
        remote_develop = refs.get("refs/heads/develop")
        tracked_develop = rev_parse(self.repo, "refs/remotes/origin/develop")
        add(
            self.checks,
            "develop.remote",
            bool(head) and head == remote_develop == tracked_develop,
            f"local={head or 'missing'} tracked={tracked_develop or 'missing'} remote={remote_develop or 'missing'}",
        )
        return head, develop, refs

    def prepared(self) -> None:
        head, develop, refs = self.common_repo()
        assert self.tag is not None
        match = TAG_PATTERN.fullmatch(self.tag)
        main = rev_parse(self.repo, "refs/heads/main")
        tracked_main = rev_parse(self.repo, "refs/remotes/origin/main")
        remote_main = refs.get("refs/heads/main")
        add(
            self.checks,
            "main.synchronized",
            bool(main) and main == tracked_main == remote_main,
            f"local={main or 'missing'} tracked={tracked_main or 'missing'} remote={remote_main or 'missing'}",
        )
        ancestor = bool(main and develop) and git(self.repo, "merge-base", "--is-ancestor", main, develop).returncode == 0
        add(self.checks, "main.fast-forwardable", ancestor, f"main={main or 'missing'} develop={develop or 'missing'}")
        version, error = package_version(self.repo, head or "HEAD")
        expected = match.group("version") if match else None
        add(self.checks, "version.target", bool(expected) and version == expected, error or f"package={version or 'missing'} tag={expected or 'invalid'}")
        local_tag = rev_parse(self.repo, f"refs/tags/{self.tag}")
        tag_refs, tag_error = remote_refs(self.repo, f"refs/tags/{self.tag}", f"refs/tags/{self.tag}^{{}}")
        add(self.checks, "tag.local-absent", local_tag is None, local_tag or "absent")
        add(self.checks, "tag.remote-readable", tag_error is None, tag_error or "origin tags read")
        add(self.checks, "tag.remote-absent", not tag_refs, json.dumps(tag_refs, sort_keys=True) if tag_refs else "absent")

    def promoted(self) -> str | None:
        head, develop, refs = self.common_repo()
        assert self.tag is not None
        match = TAG_PATTERN.fullmatch(self.tag)
        tag_ref = f"refs/tags/{self.tag}"
        tag_object = rev_parse(self.repo, tag_ref)
        tag_sha = rev_parse(self.repo, f"{tag_ref}^{{commit}}")
        tag_type = git(self.repo, "cat-file", "-t", tag_ref)
        add(self.checks, "tag.annotated", tag_type.returncode == 0 and tag_type.stdout == "tag", tag_type.stdout or tag_type.stderr or "missing")
        add(
            self.checks,
            "tag.at-develop",
            bool(tag_sha) and tag_sha == head == develop,
            f"tag={tag_sha or 'missing'} HEAD={head or 'missing'} develop={develop or 'missing'}",
        )
        version, error = package_version(self.repo, tag_sha or "HEAD")
        expected = match.group("version") if match else None
        add(self.checks, "tag.version", bool(expected) and version == expected, error or f"package={version or 'missing'} tag={expected or 'invalid'}")
        main = rev_parse(self.repo, "refs/heads/main")
        tracked_main = rev_parse(self.repo, "refs/remotes/origin/main")
        remote_main = refs.get("refs/heads/main")
        add(
            self.checks,
            "main.promoted",
            bool(tag_sha) and tag_sha == main == tracked_main == remote_main,
            f"tag={tag_sha or 'missing'} local={main or 'missing'} tracked={tracked_main or 'missing'} remote={remote_main or 'missing'}",
        )
        tag_refs, tag_error = remote_refs(self.repo, tag_ref, f"{tag_ref}^{{}}")
        remote_object = tag_refs.get(tag_ref)
        remote_peeled = tag_refs.get(f"{tag_ref}^{{}}")
        add(self.checks, "tag.remote-readable", tag_error is None, tag_error or "origin tags read")
        add(
            self.checks,
            "tag.remote",
            bool(tag_object and tag_sha) and remote_object == tag_object and remote_peeled == tag_sha,
            f"local-object={tag_object or 'missing'} remote-object={remote_object or 'missing'} local-commit={tag_sha or 'missing'} remote-commit={remote_peeled or 'missing'}",
        )
        reachable = bool(tag_sha and main) and git(self.repo, "merge-base", "--is-ancestor", tag_sha, main).returncode == 0
        add(self.checks, "tag.reachable-main", reachable, f"tag={tag_sha or 'missing'} main={main or 'missing'}")
        return tag_sha

    def built(self) -> tuple[str | None, Path | None]:
        tag_sha = self.promoted()
        release = self.state_dir / "releases" / tag_sha if tag_sha else None
        exists = bool(release and release.is_dir() and not release.is_symlink())
        add(self.checks, "release.directory", exists, str(release) if release else "target SHA missing")
        release_sha = read_text(release / ".jimi-release") if release else None
        release_tag = read_text(release / ".jimi-tag") if release else None
        add(self.checks, "release.sha", bool(tag_sha) and release_sha == tag_sha, f"metadata={release_sha or 'missing'} expected={tag_sha or 'missing'}")
        add(self.checks, "release.tag", release_tag == self.tag, f"metadata={release_tag or 'missing'} expected={self.tag}")
        artifacts = (
            ("release.next-build", release / ".next" / "BUILD_ID" if release else None, True),
            ("release.next-runner", release / "node_modules" / "next" / "dist" / "bin" / "next" if release else None, False),
            (
                "release.proxy-runner",
                release / "ops" / "codex-proxy" / "node_modules" / "openai-oauth" / "dist" / "cli.js" if release else None,
                False,
            ),
        )
        for code, path, require_text in artifacts:
            ok = bool(path and path.is_file() and (not require_text or bool(read_text(path))))
            add(self.checks, code, ok, str(path) if path else "release path missing")
        return tag_sha, release

    def current(self) -> None:
        status = git(self.repo, "status", "--porcelain=v1", "--untracked-files=all")
        add(self.checks, "repo.clean", status.returncode == 0 and not status.stdout, status.stdout or status.stderr or "clean")
        current_link = self.state_dir / "current"
        current: Path | None = None
        try:
            current = current_link.resolve(strict=True)
        except OSError:
            pass
        add(self.checks, "current.symlink", current_link.is_symlink() and bool(current and current.is_dir()), str(current or current_link))
        release_sha = read_text(current / ".jimi-release") if current else None
        release_tag = read_text(current / ".jimi-tag") if current else None
        metadata_valid = bool(
            release_sha
            and SHA_PATTERN.fullmatch(release_sha)
            and release_tag
            and TAG_PATTERN.fullmatch(release_tag)
        )
        add(
            self.checks,
            "current.metadata",
            metadata_valid,
            f"tag={release_tag or 'missing'} sha={release_sha or 'missing'}",
        )
        expected_release = self.state_dir / "releases" / release_sha if metadata_valid and release_sha else None
        add(
            self.checks,
            "current.release-directory",
            bool(current and expected_release)
            and current == expected_release.resolve()
            and expected_release.is_dir()
            and not expected_release.is_symlink(),
            f"current={current or 'missing'} expected={expected_release or 'missing'}",
        )
        tag_ref = f"refs/tags/{release_tag}" if release_tag else None
        local_tag_object = rev_parse(self.repo, tag_ref) if tag_ref else None
        local_tag_sha = rev_parse(self.repo, f"{tag_ref}^{{commit}}") if tag_ref else None
        local_tag_type = git(self.repo, "cat-file", "-t", tag_ref) if tag_ref else CommandResult(1, "", "missing tag")
        add(
            self.checks,
            "current.annotated-tag",
            local_tag_type.returncode == 0 and local_tag_type.stdout == "tag",
            local_tag_type.stdout or local_tag_type.stderr or "missing",
        )
        add(self.checks, "current.local-tag", bool(release_sha) and local_tag_sha == release_sha, f"tag={local_tag_sha or 'missing'} release={release_sha or 'missing'}")
        tag_refs: dict[str, str] = {}
        tag_error: str | None = None
        if release_tag:
            assert tag_ref is not None
            tag_refs, tag_error = remote_refs(self.repo, tag_ref, f"{tag_ref}^{{}}")
        remote_object = tag_refs.get(tag_ref) if tag_ref else None
        remote_sha = tag_refs.get(f"refs/tags/{release_tag}^{{}}") if release_tag else None
        add(
            self.checks,
            "current.remote-tag",
            tag_error is None
            and bool(release_sha)
            and remote_sha == release_sha
            and remote_object == local_tag_object,
            tag_error
            or (
                f"local-object={local_tag_object or 'missing'} "
                f"remote-object={remote_object or 'missing'} "
                f"remote-commit={remote_sha or 'missing'} release={release_sha or 'missing'}"
            ),
        )
        units = {unit: unit_state(unit) for unit in UNITS}
        self._runtime_checks(units, current)
        pids = {unit: int(state.get("pid") or 0) for unit, state in units.items()}
        self.snapshot = {
            "release_dir": str(current) if current else None,
            "release_sha": release_sha,
            "release_tag": release_tag,
            "pids": pids,
        }

    def active(
        self,
        previous_snapshot: dict[str, Any] | None,
        attestation_key: bytes | None,
    ) -> None:
        tag_sha, release = self.built()
        current_link = self.state_dir / "current"
        current: Path | None = None
        try:
            current = current_link.resolve(strict=True)
        except OSError:
            pass
        add(
            self.checks,
            "current.release",
            bool(release and current) and current == release.resolve(),
            f"current={current or 'missing'} expected={release or 'missing'}",
        )
        units = {unit: unit_state(unit) for unit in UNITS}
        self._runtime_checks(units, release)
        self.checks.extend(
            validate_previous_snapshot(
                previous_snapshot,
                target_sha=tag_sha,
                current_units=units,
                repo=self.repo,
                state_dir=self.state_dir,
                attestation_key=attestation_key,
            )
        )
        current_sha = read_text(current / ".jimi-release") if current else None
        current_tag = read_text(current / ".jimi-tag") if current else None
        self.snapshot = {
            "release_dir": str(current) if current else None,
            "release_sha": current_sha,
            "release_tag": current_tag,
            "pids": {unit: int(state.get("pid") or 0) for unit, state in units.items()},
        }

    def _runtime_checks(self, units: dict[str, dict[str, Any]], release: Path | None) -> None:
        for unit, state in units.items():
            active = state.get("command_ok") and state.get("active") == "active" and int(state.get("pid") or 0) > 0
            add(
                self.checks,
                f"unit.active.{unit}",
                bool(active),
                f"active={state.get('active')} sub={state.get('sub')} pid={state.get('pid')} error={state.get('error') or '-'}",
            )
            cwd = Path(state["cwd"]) if state.get("cwd") else None
            add(
                self.checks,
                f"unit.cwd.{unit}",
                bool(release) and inside(cwd, release.resolve()),
                f"cwd={cwd or 'missing'} release={release or 'missing'}",
            )
        for code, url in READY_URLS:
            ok, detail = probe(url)
            add(self.checks, code, ok, detail)


def load_snapshot(path: Path | None) -> tuple[dict[str, Any] | None, str | None]:
    if path is None:
        return None, "--previous-snapshot is required for active phase"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, str(error)
    if not isinstance(data, dict):
        return None, "snapshot root must be an object"
    return data, None


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--phase", required=True, choices=("current", "prepared", "promoted", "built", "active"))
    result.add_argument("--tag", help="target annotated version tag (required except for current)")
    result.add_argument("--repo", default=".", help="repository checkout (default: current directory)")
    result.add_argument("--state-dir", default=str(Path.home() / "releases" / "jimi-wiki"))
    result.add_argument("--previous-snapshot", type=Path, help="JSON emitted by --phase current --json")
    result.add_argument(
        "--attestation-key",
        type=Path,
        default=Path(
            os.environ.get(
                "JIMI_SNAPSHOT_KEY_FILE",
                os.environ.get(
                    "JIMI_ACTIONS_KEY_FILE",
                    str(Path.home() / ".config" / "jimi-wiki" / "server-actions-key"),
                ),
            )
        ),
        help="owner-only key used to authenticate current snapshots",
    )
    result.add_argument("--json", action="store_true", help="emit one machine-readable JSON object")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.phase != "current" and not args.tag:
        parser().error("--tag is required for prepared, promoted, built, and active")
    if args.tag and not TAG_PATTERN.fullmatch(args.tag):
        parser().error("--tag must match vX.Y.Z")
    if args.phase == "active" and args.previous_snapshot is None:
        parser().error("--previous-snapshot is required for active")

    requested_repo = Path(args.repo).expanduser().resolve()
    root_result = git(requested_repo, "rev-parse", "--show-toplevel")
    if root_result.returncode != 0:
        print(root_result.stderr or f"not a Git repository: {requested_repo}", file=sys.stderr)
        return 2
    repo = Path(root_result.stdout).resolve()
    inspector = Inspector(repo=repo, state_dir=Path(args.state_dir).expanduser().resolve(), tag=args.tag)
    attestation_key: bytes | None = None
    if args.phase in ("current", "active"):
        key_path = args.attestation_key.expanduser().resolve()
        attestation_key, key_error = load_attestation_key(key_path)
        add(
            inspector.checks,
            "snapshot.key",
            key_error is None,
            key_error or f"owner-only key loaded: {key_path}",
        )

    if args.phase == "current":
        inspector.current()
    elif args.phase == "prepared":
        inspector.prepared()
    elif args.phase == "promoted":
        inspector.promoted()
    elif args.phase == "built":
        inspector.built()
    else:
        snapshot, error = load_snapshot(args.previous_snapshot)
        if error:
            add(inspector.checks, "previous.snapshot", False, error)
        inspector.active(snapshot, attestation_key)

    ok = all(check.ok for check in inspector.checks)
    payload = {
        "schema_version": 1,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "phase": args.phase,
        "tag": args.tag,
        "ok": ok,
        "repo": str(repo),
        "state_dir": str(inspector.state_dir),
        "checks": [asdict(check) for check in inspector.checks],
        "snapshot": inspector.snapshot,
    }
    if args.phase == "current" and ok and attestation_key is not None:
        attest_snapshot(payload, attestation_key)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    else:
        for check in inspector.checks:
            print(f"[{'PASS' if check.ok else 'FAIL'}] {check.code}: {check.detail}")
        print(f"RESULT {'OK' if ok else 'INCOMPLETE'} phase={args.phase} tag={args.tag or '-'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
