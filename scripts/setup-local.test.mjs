import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectPreflight,
  evaluateNodeVersion,
  parseArgs,
  parseEnvText,
  prepareEnvironment,
  prepareEnvText,
  setEnvValue,
} from "./setup-local.mjs";

const template = `POSTGRES_PASSWORD="replace-with-a-long-random-value"
DATABASE_URL="postgresql://jimi:replace-with-a-long-random-value@127.0.0.1:5434/jimi?schema=public"
APP_URL="http://localhost:3006"
AUTH_SECRET="dev-secret-change-me"
AUTH_MODE="local"
GEMINI_API_KEY=""
# OPENAI_OAUTH_PERSONAL="1"
# OPENAI_TRANSPORT="apikey"
EMBED_PROVIDER="local"
EMBED_BASE_URL="http://127.0.0.1:8081"
# EMBED_MODEL="nlpai-lab/KURE-v1"
EMBED_DIM="1024"
`;
const DEFAULT_EMBED_BASE_LINE = 'EMBED_BASE_URL="http://127.0.0.1:8081"';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jimi-setup-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jimi-wiki-app" }));
  writeFileSync(join(root, ".env.example"), template);
  return root;
}

test("parseArgs accepts strict setup profiles and rejects unknown options", () => {
  const parsed = parseArgs(["prepare", "--oauth", "--embed-model", "nlpai-lab/KURE-v1", "--repo", "."]);
  assert.equal(parsed.command, "prepare");
  assert.equal(parsed.oauth, true);
  assert.equal(parsed.embedModel, "nlpai-lab/KURE-v1");
  assert.equal(parseArgs(["--", "check", "--embedding", "external"]).embedding, "external");
  assert.equal(
    parseArgs([
      "prepare",
      "--embedding",
      "external",
      "--embed-url",
      "https://tei.example.test",
      "--embed-model",
      "nlpai-lab/KURE-v1",
    ]).embedUrl,
    "https://tei.example.test",
  );
  assert.throws(() => parseArgs(["check", "--surprise"]), /unknown option/);
  assert.throws(() => parseArgs(["check", "--embedding", "ollama"]), /invalid embedding profile/);
  assert.throws(() => parseArgs(["prepare", "--embed-model", "$(unsafe)"]), /safe Hugging Face model id/);
  assert.throws(() => parseArgs(["verify", "--app-url", "http://secret@example.com"]), /invalid --app-url/);
  assert.throws(() => parseArgs(["verify", "--app-url", "http://localhost:3006?token=secret"]), /invalid --app-url/);
  assert.throws(() => parseArgs(["prepare", "--embedding", "external"]), /requires --embed-url and --embed-model/);
  assert.throws(
    () => parseArgs(["prepare", "--embedding", "gemini", "--embed-model", "BAAI/bge-m3"]),
    /not valid with --embedding gemini/,
  );
});

test("setEnvValue updates commented entries instead of appending duplicates", () => {
  const next = setEnvValue(template, "OPENAI_TRANSPORT", "oauth");
  assert.equal(next.match(/OPENAI_TRANSPORT=/g)?.length, 1);
  assert.match(next, /^OPENAI_TRANSPORT="oauth"$/m);
});

test("prepareEnvText creates matching DB credentials and OAuth/local embedding config", () => {
  const next = prepareEnvText(template, {
    oauth: true,
    embedModel: "nlpai-lab/KURE-v1",
    password: "a".repeat(64),
    authSecret: "b".repeat(64),
  });
  const values = parseEnvText(next);
  assert.equal(values.get("POSTGRES_PASSWORD"), "a".repeat(64));
  assert.equal(
    values.get("DATABASE_URL"),
    `postgresql://jimi:${"a".repeat(64)}@127.0.0.1:5434/jimi?schema=public`,
  );
  assert.equal(values.get("AUTH_SECRET"), "b".repeat(64));
  assert.equal(values.get("OPENAI_OAUTH_PERSONAL"), "1");
  assert.equal(values.get("OPENAI_TRANSPORT"), "oauth");
  assert.equal(values.get("EMBED_MODEL"), "nlpai-lab/KURE-v1");
  assert.doesNotMatch(next, /replace-with|dev-secret-change-me/);
});

test("prepareEnvText preserves the selected external or Gemini embedding profile", () => {
  const external = parseEnvText(
    prepareEnvText(template, {
      embedding: "external",
      embedUrl: "https://tei.example.test/team",
      embedModel: "nlpai-lab/KURE-v1",
      password: "l".repeat(64),
      authSecret: "m".repeat(64),
    }),
  );
  assert.equal(external.get("EMBED_PROVIDER"), "local");
  assert.equal(external.get("EMBED_BASE_URL"), "https://tei.example.test/team");
  assert.equal(external.get("EMBED_MODEL"), "nlpai-lab/KURE-v1");

  const gemini = parseEnvText(
    prepareEnvText(template, {
      embedding: "gemini",
      password: "n".repeat(64),
      authSecret: "o".repeat(64),
    }),
  );
  assert.equal(gemini.get("EMBED_PROVIDER"), "gemini");
  assert.equal(gemini.get("EMBED_BASE_URL"), "");
  assert.equal(gemini.get("EMBED_MODEL"), "gemini-embedding-001");
});

test("prepareEnvironment writes mode 0600 once and refuses an existing .env", () => {
  const root = fixture();
  try {
    const prepared = prepareEnvironment({
      repoRoot: root,
      oauth: true,
      embedModel: "nlpai-lab/KURE-v1",
      password: "c".repeat(64),
      authSecret: "d".repeat(64),
    });
    const first = readFileSync(prepared.envPath, "utf8");
    assert.equal(statSync(prepared.envPath).mode & 0o777, 0o600);
    assert.throws(() => prepareEnvironment({ repoRoot: root }), /refusing to overwrite/);
    assert.equal(readFileSync(prepared.envPath, "utf8"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight output never includes configured secrets", () => {
  const root = fixture();
  try {
    const secret = "never-print-this-auth-secret-value";
    writeFileSync(
      join(root, ".env"),
      prepareEnvText(template, {
        password: "e".repeat(64),
        authSecret: secret,
        embedModel: "BAAI/bge-m3",
      }),
      { mode: 0o600 },
    );
    const passProbe = (command, args) => {
      if (command === "docker" && args[0] === "ps") return { ok: true, output: "", status: 0 };
      if (command === "docker" && args[0] === "info") return { ok: true, output: '{"nvidia":{}}', status: 0 };
      if (command === "nvidia-smi") return { ok: true, output: "GPU 0", status: 0 };
      return { ok: true, output: "1.0.0", status: 0 };
    };
    const checks = collectPreflight({
      repoRoot: root,
      embedding: "local",
      probe: passProbe,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.0.0",
    });
    assert.doesNotMatch(JSON.stringify(checks), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(checks), /e{32}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects an empty OAuth store and an empty Prisma output directory", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, ".env"),
      prepareEnvText(template, {
        oauth: true,
        password: "r".repeat(64),
        authSecret: "s".repeat(64),
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(root, ".openai-oauth.json"), "", { mode: 0o600 });
    mkdirSync(join(root, "src", "generated", "prisma"), { recursive: true });
    const passProbe = (command, args) => {
      if (command === "docker" && args[0] === "ps") return { ok: true, output: "", status: 0 };
      if (command === "ss") return { ok: true, output: "", status: 0 };
      if (command === "docker" && args[0] === "info") return { ok: true, output: '{"nvidia":{}}', status: 0 };
      if (command === "nvidia-smi") return { ok: true, output: "GPU 0", status: 0 };
      return { ok: true, output: "1.0.0", status: 0 };
    };
    const checks = collectPreflight({
      repoRoot: root,
      embedding: "local",
      probe: passProbe,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.0.0",
    });
    assert.equal(checks.find((check) => check.id === "oauth.store")?.status, "warn");
    assert.equal(checks.find((check) => check.id === "prisma.client")?.status, "warn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-local profiles do not reserve the bundled TEI port", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, ".env"),
      prepareEnvText(template, {
        password: "f".repeat(64),
        authSecret: "g".repeat(64),
      })
        .replace('EMBED_PROVIDER="local"', 'EMBED_PROVIDER="gemini"')
        .replace('GEMINI_API_KEY=""', 'GEMINI_API_KEY="configured-but-never-printed"'),
      { mode: 0o600 },
    );
    const calls = [];
    const passProbe = (command, args) => {
      calls.push([command, ...args]);
      return { ok: true, output: command === "docker" && args[0] === "ps" ? "" : "1.0.0", status: 0 };
    };
    const checks = collectPreflight({
      repoRoot: root,
      embedding: "gemini",
      probe: passProbe,
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "20.0.0",
    });
    assert.equal(checks.find((check) => check.id === "env.embedding")?.status, "pass");
    assert.equal(calls.some((call) => call.includes("publish=8081")), false);
    assert.equal(calls.some((call) => call[0] === "nvidia-smi"), false);
    assert.doesNotMatch(JSON.stringify(checks), /configured-but-never-printed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight fails when a host listener occupies a required port outside Docker", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, ".env"),
      prepareEnvText(template, {
        password: "p".repeat(64),
        authSecret: "q".repeat(64),
      }),
      { mode: 0o600 },
    );
    const probe = (command, args) => {
      if (command === "docker" && args[0] === "ps") return { ok: true, output: "", status: 0 };
      if (command === "ss") {
        const port = args.at(-1);
        return {
          ok: true,
          output: port === "sport = :8081" ? "LISTEN 0 4096 127.0.0.1:8081 0.0.0.0:*" : "",
          status: 0,
        };
      }
      if (command === "docker" && args[0] === "info") return { ok: true, output: '{"nvidia":{}}', status: 0 };
      if (command === "nvidia-smi") return { ok: true, output: "GPU 0", status: 0 };
      return { ok: true, output: "1.0.0", status: 0 };
    };
    const checks = collectPreflight({
      repoRoot: root,
      embedding: "local",
      probe,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.0.0",
    });
    assert.equal(checks.find((check) => check.id === "port.5434")?.status, "pass");
    assert.equal(checks.find((check) => check.id === "port.8081")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external TEI profile rejects non-HTTP and credentialed endpoints", () => {
  const root = fixture();
  try {
    const configured = prepareEnvText(template, {
      password: "h".repeat(64),
      authSecret: "i".repeat(64),
    });
    const passProbe = () => ({ ok: true, output: "1.0.0", status: 0 });
    for (const unsafeBase of ["file:///tmp/embedding", "http://secret@example.com"]) {
      writeFileSync(
        join(root, ".env"),
        configured.replace(DEFAULT_EMBED_BASE_LINE, `EMBED_BASE_URL="${unsafeBase}"`),
        { mode: 0o600 },
      );
      const checks = collectPreflight({
        repoRoot: root,
        embedding: "external",
        probe: passProbe,
        platform: "darwin",
        arch: "arm64",
        nodeVersion: "20.0.0",
      });
      assert.equal(checks.find((check) => check.id === "env.embedding")?.status, "fail");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects an embedding dimension incompatible with the schema", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, ".env"),
      prepareEnvText(template, {
        password: "j".repeat(64),
        authSecret: "k".repeat(64),
      }).replace('EMBED_DIM="1024"', 'EMBED_DIM="768"'),
      { mode: 0o600 },
    );
    const passProbe = (command, args) => ({
      ok: true,
      output: command === "docker" && args[0] === "ps" ? "" : '{"nvidia":{}}',
      status: 0,
    });
    const checks = collectPreflight({
      repoRoot: root,
      embedding: "local",
      probe: passProbe,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.0.0",
    });
    assert.equal(checks.find((check) => check.id === "env.embedding")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node 20 is the minimum supported setup runtime", () => {
  assert.equal(evaluateNodeVersion("20.0.0"), true);
  assert.equal(evaluateNodeVersion("24.3.1"), true);
  assert.equal(evaluateNodeVersion("19.9.0"), false);
  assert.equal(evaluateNodeVersion("invalid"), false);
});
