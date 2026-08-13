from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("release_status.py")
SPEC = importlib.util.spec_from_file_location("release_status", SCRIPT)
assert SPEC and SPEC.loader
release_status = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release_status
SPEC.loader.exec_module(release_status)
ATTESTATION_KEY = b"release-status-test-attestation-key"


def command(*argv: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if check and result.returncode != 0:
        raise AssertionError(f"command failed: {argv}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result


class ReleaseFixture:
    def __init__(self, root: Path):
        self.root = root
        self.origin = root / "origin.git"
        self.repo = root / "repo"
        self.state = root / "state"
        command("git", "init", "--bare", str(self.origin))
        command("git", "init", "--initial-branch=main", str(self.repo))
        command("git", "config", "user.name", "Release Test", cwd=self.repo)
        command("git", "config", "user.email", "release@example.test", cwd=self.repo)
        command("git", "remote", "add", "origin", str(self.origin), cwd=self.repo)
        self._write_version("0.4.8")
        command("git", "add", "package.json", cwd=self.repo)
        command("git", "commit", "-m", "chore(release): v0.4.8", cwd=self.repo)
        command("git", "push", "-u", "origin", "main", cwd=self.repo)
        self.old_sha = command("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        self.old_release = self.state / "releases" / self.old_sha
        self.old_release.mkdir(parents=True)
        (self.old_release / ".jimi-release").write_text(f"{self.old_sha}\n", encoding="utf-8")
        (self.old_release / ".jimi-tag").write_text("v0.4.8\n", encoding="utf-8")
        command("git", "switch", "-c", "develop", cwd=self.repo)
        self._write_version("0.4.9")
        command("git", "add", "package.json", cwd=self.repo)
        command("git", "commit", "-m", "feat: candidate", cwd=self.repo)
        command("git", "push", "-u", "origin", "develop", cwd=self.repo)

    def _write_version(self, version: str) -> None:
        (self.repo / "package.json").write_text(json.dumps({"name": "fixture", "version": version}) + "\n", encoding="utf-8")

    def run(self, phase: str, *, tag: str = "v0.4.9") -> subprocess.CompletedProcess[str]:
        return command(
            sys.executable,
            str(SCRIPT),
            "--repo",
            str(self.repo),
            "--state-dir",
            str(self.state),
            "--phase",
            phase,
            "--tag",
            tag,
            check=False,
        )

    def promote(self, *, push_tag: bool = True) -> str:
        sha = command("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        command("git", "branch", "-f", "main", sha, cwd=self.repo)
        command("git", "push", "origin", f"{sha}:refs/heads/main", cwd=self.repo)
        command("git", "tag", "-a", "v0.4.9", "-m", "v0.4.9", cwd=self.repo)
        if push_tag:
            command("git", "push", "origin", "v0.4.9", cwd=self.repo)
        command("git", "fetch", "origin", "main", "develop", "--tags", cwd=self.repo)
        return sha

    def build(self, sha: str) -> Path:
        release = self.state / "releases" / sha
        (release / ".next").mkdir(parents=True)
        (release / ".next" / "BUILD_ID").write_text("fixture-build\n", encoding="utf-8")
        next_runner = release / "node_modules" / "next" / "dist" / "bin" / "next"
        next_runner.parent.mkdir(parents=True)
        next_runner.write_text("fixture\n", encoding="utf-8")
        proxy_runner = release / "ops" / "codex-proxy" / "node_modules" / "openai-oauth" / "dist" / "cli.js"
        proxy_runner.parent.mkdir(parents=True)
        proxy_runner.write_text("fixture\n", encoding="utf-8")
        (release / ".jimi-release").write_text(f"{sha}\n", encoding="utf-8")
        (release / ".jimi-tag").write_text("v0.4.9\n", encoding="utf-8")
        return release

    def commit_version(self, version: str) -> None:
        self._write_version(version)
        command("git", "add", "package.json", cwd=self.repo)
        command("git", "commit", "-m", f"chore(release): v{version}", cwd=self.repo)
        command("git", "push", "origin", "develop", cwd=self.repo)


class ReleaseStatusTests(unittest.TestCase):
    def test_prepared_promoted_and_built_checkpoints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = ReleaseFixture(Path(directory))
            prepared = fixture.run("prepared")
            self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
            self.assertIn("RESULT OK phase=prepared", prepared.stdout)

            missing_tag = fixture.run("promoted")
            self.assertEqual(missing_tag.returncode, 1)
            self.assertIn("[FAIL] tag.annotated", missing_tag.stdout)

            sha = fixture.promote()
            promoted = fixture.run("promoted")
            self.assertEqual(promoted.returncode, 0, promoted.stdout + promoted.stderr)
            self.assertIn("[PASS] tag.remote", promoted.stdout)

            release = fixture.build(sha)
            built = fixture.run("built")
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            self.assertIn("RESULT OK phase=built", built.stdout)

            (release / ".jimi-tag").write_text("v0.4.8\n", encoding="utf-8")
            corrupt = fixture.run("built")
            self.assertEqual(corrupt.returncode, 1)
            self.assertIn("[FAIL] release.tag", corrupt.stdout)

            (release / ".jimi-tag").write_text("v0.4.9\n", encoding="utf-8")
            relocated = fixture.state / "relocated-release"
            release.rename(relocated)
            release.symlink_to(relocated, target_is_directory=True)
            symlinked = fixture.run("built")
            self.assertEqual(symlinked.returncode, 1)
            self.assertIn("[FAIL] release.directory", symlinked.stdout)

    def test_unpushed_annotated_tag_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = ReleaseFixture(Path(directory))
            fixture.promote(push_tag=False)
            result = fixture.run("promoted")
            self.assertEqual(result.returncode, 1)
            self.assertIn("[FAIL] tag.remote", result.stdout)

    def test_package_version_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = ReleaseFixture(Path(directory))
            fixture.commit_version("0.4.10")
            result = fixture.run("prepared", tag="v0.4.9")
            self.assertEqual(result.returncode, 1)
            self.assertIn("[FAIL] version.target", result.stdout)

    def test_active_rejects_wrong_current_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = ReleaseFixture(Path(directory))
            sha = fixture.promote()
            release = fixture.build(sha)
            wrong_release = fixture.state / "releases" / ("f" * 40)
            wrong_release.mkdir(parents=True)
            (fixture.state / "current").symlink_to(wrong_release)
            previous = {
                "schema_version": 1,
                "phase": "current",
                "ok": True,
                "repo": str(fixture.repo),
                "state_dir": str(fixture.state),
                "snapshot": {
                    "release_dir": str(fixture.old_release),
                    "release_sha": fixture.old_sha,
                    "release_tag": "v0.4.8",
                    "pids": {unit: index + 100 for index, unit in enumerate(release_status.UNITS)},
                },
            }
            release_status.attest_snapshot(previous, ATTESTATION_KEY)
            (fixture.state / "previous").symlink_to(fixture.old_release)

            def fake_unit_state(unit: str) -> dict[str, object]:
                restarted = unit in release_status.RESTARTED_UNITS
                return {
                    "unit": unit,
                    "command_ok": True,
                    "active": "active",
                    "sub": "running",
                    "pid": release_status.UNITS.index(unit) + (200 if restarted else 100),
                    "cwd": str(release if restarted else fixture.old_release),
                    "error": None,
                }

            inspector = release_status.Inspector(fixture.repo, fixture.state, "v0.4.9")
            with (
                mock.patch.object(release_status, "unit_state", side_effect=fake_unit_state),
                mock.patch.object(release_status, "probe", return_value=(True, "HTTP 200 fixture")),
            ):
                inspector.active(previous, ATTESTATION_KEY)
            failed = [check for check in inspector.checks if not check.ok]
            self.assertEqual([check.code for check in failed], ["current.release"])
            self.assertIsNone(inspector.snapshot["release_sha"])

            (fixture.state / "current").unlink()
            (fixture.state / "current").symlink_to(release)
            inspector = release_status.Inspector(fixture.repo, fixture.state, "v0.4.9")
            with (
                mock.patch.object(release_status, "unit_state", side_effect=fake_unit_state),
                mock.patch.object(release_status, "probe", return_value=(True, "HTTP 200 fixture")),
            ):
                inspector.active(previous, ATTESTATION_KEY)
            self.assertTrue(all(check.ok for check in inspector.checks), inspector.checks)
            self.assertEqual(inspector.snapshot["release_sha"], sha)

    def test_active_rejects_shared_proxy_outside_an_immutable_release_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = ReleaseFixture(Path(directory))
            sha = fixture.promote()
            release = fixture.build(sha)
            (fixture.state / "current").symlink_to(release)
            (fixture.state / "previous").symlink_to(fixture.old_release)
            mutable = fixture.state / "releases" / "mutable-proxy-checkout"
            mutable.mkdir()
            previous = {
                "schema_version": 1,
                "phase": "current",
                "ok": True,
                "repo": str(fixture.repo),
                "state_dir": str(fixture.state),
                "snapshot": {
                    "release_dir": str(fixture.old_release),
                    "release_sha": fixture.old_sha,
                    "release_tag": "v0.4.8",
                    "pids": {unit: index + 100 for index, unit in enumerate(release_status.UNITS)},
                },
            }
            release_status.attest_snapshot(previous, ATTESTATION_KEY)

            def fake_unit_state(unit: str) -> dict[str, object]:
                restarted = unit in release_status.RESTARTED_UNITS
                return {
                    "unit": unit,
                    "command_ok": True,
                    "active": "active",
                    "sub": "running",
                    "pid": release_status.UNITS.index(unit) + (200 if restarted else 100),
                    "cwd": str(release if restarted else mutable),
                    "error": None,
                }

            inspector = release_status.Inspector(fixture.repo, fixture.state, "v0.4.9")
            with (
                mock.patch.object(release_status, "unit_state", side_effect=fake_unit_state),
                mock.patch.object(release_status, "probe", return_value=(True, "HTTP 200 fixture")),
            ):
                inspector.active(previous, ATTESTATION_KEY)
            self.assertEqual(
                [check.code for check in inspector.checks if not check.ok],
                [f"unit.cwd.{release_status.SHARED_UNITS[0]}"],
            )

    def test_previous_snapshot_requires_owned_pid_changes_and_shared_pid_stability(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            state = root / "state"
            repo.mkdir()
            old_sha = "e" * 40
            old_release = state / "releases" / old_sha
            old_release.mkdir(parents=True)
            (old_release / ".jimi-release").write_text(f"{old_sha}\n", encoding="utf-8")
            (old_release / ".jimi-tag").write_text("v0.4.8\n", encoding="utf-8")
            (state / "previous").symlink_to(old_release)
            old = {
                "schema_version": 1,
                "phase": "current",
                "ok": True,
                "repo": str(repo),
                "state_dir": str(state),
                "snapshot": {
                    "release_dir": str(old_release),
                    "release_sha": old_sha,
                    "release_tag": "v0.4.8",
                    "pids": {unit: index + 100 for index, unit in enumerate(release_status.UNITS)},
                },
            }
            release_status.attest_snapshot(old, ATTESTATION_KEY)
            unchanged_units = {
                unit: {"pid": index + 100} for index, unit in enumerate(release_status.UNITS)
            }
            failed = release_status.validate_previous_snapshot(
                old,
                target_sha=old_sha,
                current_units=unchanged_units,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertTrue(any(not check.ok and check.code == "previous.release" for check in failed))
            self.assertEqual(sum(not check.ok for check in failed if check.code.startswith("pid.changed.")), 2)
            self.assertFalse(any(not check.ok for check in failed if check.code.startswith("pid.unchanged.")))

            changed_units = {}
            for index, unit in enumerate(release_status.UNITS):
                offset = 200 if unit in release_status.RESTARTED_UNITS else 100
                changed_units[unit] = {"pid": index + offset}
            passed = release_status.validate_previous_snapshot(
                old,
                target_sha="d" * 40,
                current_units=changed_units,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertTrue(all(check.ok for check in passed), passed)

            restarted_shared = copy.deepcopy(changed_units)
            for unit in release_status.SHARED_UNITS:
                restarted_shared[unit]["pid"] += 100
            disrupted = release_status.validate_previous_snapshot(
                old,
                target_sha="d" * 40,
                current_units=restarted_shared,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertEqual(
                [check.code for check in disrupted if not check.ok],
                [f"pid.unchanged.{release_status.SHARED_UNITS[0]}"],
            )

            unsigned_forgery = copy.deepcopy(old)
            unsigned_forgery.pop("attestation")
            unsigned_forgery["repo"] = str(root / "other-repo")
            unsigned_forgery["state_dir"] = str(root / "other-state")
            unsigned_forgery["snapshot"]["release_sha"] = "f" * 40
            unsigned_forgery["snapshot"]["release_tag"] = "v9.9.9"
            unsigned_forgery["snapshot"]["release_dir"] = str(root / "not-a-release")
            unsigned_forgery["snapshot"]["pids"] = {
                unit: 900_000 + index for index, unit in enumerate(release_status.UNITS)
            }
            forged = release_status.validate_previous_snapshot(
                unsigned_forgery,
                target_sha="d" * 40,
                current_units=changed_units,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertIn("previous.attestation", [check.code for check in forged if not check.ok])

            old["repo"] = str(root / "other-repo")
            old["state_dir"] = str(root / "other-state")
            release_status.attest_snapshot(old, ATTESTATION_KEY)
            forged = release_status.validate_previous_snapshot(
                old,
                target_sha="d" * 40,
                current_units=changed_units,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertEqual(
                [check.code for check in forged if not check.ok],
                ["previous.repo", "previous.state-dir"],
            )

            old["repo"] = str(repo)
            old["state_dir"] = str(state)
            old["snapshot"]["release_sha"] = "f" * 40
            old["snapshot"]["release_tag"] = "v9.9.9"
            old["snapshot"]["release_dir"] = str(root / "not-a-release")
            old["snapshot"]["pids"] = {
                unit: (
                    900_000 + index
                    if unit in release_status.RESTARTED_UNITS
                    else changed_units[unit]["pid"]
                )
                for index, unit in enumerate(release_status.UNITS)
            }
            release_status.attest_snapshot(old, ATTESTATION_KEY)
            forged = release_status.validate_previous_snapshot(
                old,
                target_sha="d" * 40,
                current_units=changed_units,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertEqual(
                [check.code for check in forged if not check.ok],
                ["previous.release-artifact", "previous.symlink"],
            )

            old["ok"] = False
            release_status.attest_snapshot(old, ATTESTATION_KEY)
            invalid = release_status.validate_previous_snapshot(
                old,
                target_sha="d" * 40,
                current_units=changed_units,
                repo=repo,
                state_dir=state,
                attestation_key=ATTESTATION_KEY,
            )
            self.assertEqual([check.code for check in invalid if not check.ok], ["previous.snapshot"])

    def test_invalid_tag_is_usage_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = ReleaseFixture(Path(directory))
            result = fixture.run("prepared", tag="release-latest")
            self.assertEqual(result.returncode, 2)
            self.assertIn("--tag must match vX.Y.Z", result.stderr)


if __name__ == "__main__":
    unittest.main()
