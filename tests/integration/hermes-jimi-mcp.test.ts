import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = process.cwd();

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else snapshot[relative] = readFileSync(absolute, "utf8");
    }
  };
  visit(root);
  return snapshot;
}

function fixture({ mcpTestFails = false, gatewayActive = true, reportedTool = "record_research_report" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jimi-hermes-sync-"));
  const profile = join(root, "profile");
  const release = join(root, "release");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const profileSkill = join(profile, "skills", "wiki-ingest");
  const releaseSkill = join(release, "skills", "wiki-ingest");
  const currentRelease = join(root, "current");
  mkdirSync(join(profileSkill, "references"), { recursive: true });
  mkdirSync(join(releaseSkill, "references"), { recursive: true });
  mkdirSync(join(release, "mcp"), { recursive: true });
  symlinkSync(release, currentRelease, "dir");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(profile, ".env"), "JIMI_WIKI_PERSONAL_KEY=test\n", "utf8");
  writeFileSync(join(profile, "config.yaml"), [
    "mcp_servers:",
    "  jimi-wiki:",
    "    command: /usr/bin/node",
    "    args:",
    `      - ${currentRelease}/mcp/server.mjs`,
    "    env:",
    "      JIMI_WIKI_URL: http://127.0.0.1:23007",
    "      JIMI_WIKI_API_KEY: ${JIMI_WIKI_PERSONAL_KEY}",
    "      JIMI_WIKI_SLUG: personal",
    "    connect_timeout: 60.0",
    "    enabled: true",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(profileSkill, "SKILL.md"), "stale skill\n", "utf8");
  writeFileSync(join(profileSkill, "references", "stale.md"), "stale only\n", "utf8");
  writeFileSync(join(releaseSkill, "SKILL.md"), "record_research_report\n", "utf8");
  writeFileSync(join(releaseSkill, "references", "tools.md"), "current tools\n", "utf8");
  writeFileSync(join(releaseSkill, "references", "setup.md"), "current setup\n", "utf8");
  writeFileSync(join(release, "mcp", "server.mjs"), "// fixture\n", "utf8");

  const profileCommand = join(bin, "wiki-personal");
  writeExecutable(profileCommand, `#!/usr/bin/env bash
set -euo pipefail
printf 'wiki-personal %s\\n' "$*" >> "${log}"
if [[ "$*" == "mcp test jimi-wiki" ]]; then
  ${mcpTestFails ? "echo 'fixture MCP failure' >&2; exit 1" : `printf '✓ Connected\\n${reportedTool}\\n'`}
fi
`);
  writeExecutable(join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\\n' "$*" >> "${log}"
if [[ "${gatewayActive ? "1" : "0"}" == "1" && "$*" == "--user is-active --quiet hermes-gateway.service" ]]; then
  exit 0
fi
if [[ "$*" == "--user is-active --quiet hermes-gateway.service" ]]; then
  exit 3
fi
`);

  return {
    root,
    profile,
    release,
    currentRelease,
    log,
    profileSkill,
    releaseSkill,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      HERMES_PERSONAL_COMMAND: profileCommand,
      HERMES_PERSONAL_PROFILE_DIR: profile,
      JIMI_RELEASE_DIR: release,
      JIMI_CONFIG_DIR: join(root, "config"),
    },
  };
}

function runSync(env: NodeJS.ProcessEnv) {
  return spawnSync("/usr/bin/bash", ["ops/hermes-jimi-mcp.sh", "sync-skill"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

test("Hermes skill sync atomically installs the release bundle and reloads an active gateway", () => {
  const f = fixture();
  try {
    const result = runSync(f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(treeSnapshot(f.profileSkill), treeSnapshot(f.releaseSkill));
    const calls = readFileSync(f.log, "utf8");
    assert.match(calls, /systemctl --user is-active --quiet hermes-gateway\.service/);
    assert.match(calls, /systemctl --user restart hermes-gateway\.service/);
    assert.match(calls, /wiki-personal mcp test jimi-wiki/);
    assert.deepEqual(readdirSync(join(f.profile, "skills")).sort(), ["wiki-ingest"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Hermes skill sync restores the previous bundle when MCP verification fails", () => {
  const f = fixture({ mcpTestFails: true });
  const previous = treeSnapshot(f.profileSkill);
  try {
    const result = runSync(f.env);
    assert.notEqual(result.status, 0, "verification failure must fail closed");
    assert.deepEqual(treeSnapshot(f.profileSkill), previous);
    const calls = readFileSync(f.log, "utf8");
    assert.equal((calls.match(/systemctl --user restart hermes-gateway\.service/g) ?? []).length, 2);
    assert.deepEqual(readdirSync(join(f.profile, "skills")).sort(), ["wiki-ingest"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Hermes skill sync requires the exact research report tool name", () => {
  const f = fixture({ reportedTool: "record_research_report_status" });
  const previous = treeSnapshot(f.profileSkill);
  try {
    const result = runSync(f.env);
    assert.notEqual(result.status, 0, "a longer tool name must not satisfy the required tool");
    assert.match(result.stderr, /did not expose required tool: record_research_report/);
    assert.deepEqual(treeSnapshot(f.profileSkill), previous);
    const calls = readFileSync(f.log, "utf8");
    assert.equal((calls.match(/systemctl --user restart hermes-gateway\.service/g) ?? []).length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Hermes skill sync does not start a gateway that was already stopped", () => {
  const f = fixture({ gatewayActive: false });
  try {
    const result = runSync(f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(treeSnapshot(f.profileSkill), treeSnapshot(f.releaseSkill));
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /systemctl --user restart hermes-gateway\.service/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Hermes skill sync rejects an MCP child process pinned to a different release", () => {
  const f = fixture();
  const previous = treeSnapshot(f.profileSkill);
  try {
    const staleRelease = join(f.root, "stale-release");
    mkdirSync(join(staleRelease, "mcp"), { recursive: true });
    writeFileSync(join(staleRelease, "mcp", "server.mjs"), "// stale fixture\n", "utf8");
    unlinkSync(f.currentRelease);
    symlinkSync(staleRelease, f.currentRelease, "dir");

    const result = runSync(f.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not resolve to/);
    assert.deepEqual(treeSnapshot(f.profileSkill), previous);
    assert.equal(existsSync(f.log), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("production activation wires Hermes synchronization and rollback to exact release paths", () => {
  const deploy = readFileSync(join(repoRoot, "ops", "deploy.sh"), "utf8");
  assert.match(deploy, /sync_hermes_release "\$argument"/);
  assert.match(deploy, /sync_hermes_release "\$old_target"/);
  assert.match(deploy, /JIMI_RELEASE_DIR="\$release_dir"/);
  assert.match(deploy, /hermes_touched/);
});

test("research workflow forbids code or REST fallback while MCP publishing is available", () => {
  const skill = readFileSync(join(repoRoot, "skills", "wiki-ingest", "SKILL.md"), "utf8");
  const tools = readFileSync(join(repoRoot, "skills", "wiki-ingest", "references", "tools.md"), "utf8");
  assert.match(skill, /record_research_report.*직접 호출/);
  assert.match(skill, /get_run_status.*done/);
  assert.match(skill, /output\.sourceSlug/);
  assert.match(skill, /shell|셸/);
  assert.match(skill, /REST.*우회/);
  assert.match(tools, /MCP.*연결.*record_research_report/);
  assert.match(tools, /REST.*fallback|REST.*폴백/);
});
