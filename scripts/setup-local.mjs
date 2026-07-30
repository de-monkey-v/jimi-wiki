#!/usr/bin/env node
/**
 * Fresh-clone local setup helper.
 *
 * `check` and `verify` are read-only. `prepare` is the only mutating command:
 * it creates a brand-new .env with mode 0600 and refuses to touch an existing
 * file. The script intentionally uses Node built-ins only so it can run before
 * `pnpm install`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_APP_URL = "http://127.0.0.1:3006";
const DEFAULT_LOCAL_EMBED_URL = "http://127.0.0.1:8081";
const DEFAULT_LOCAL_MODEL = "BAAI/bge-m3";
const EXPECTED_CONTAINERS = new Map([
  ["5434", "jimi-wiki-dev-db"],
  ["8081", "jimi-wiki-dev-embeddings"],
]);
const GIB = 1024n ** 3n;

class UsageError extends Error {}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function usage() {
  return `Usage:
  node scripts/setup-local.mjs check [--embedding local|external|gemini] [--json]
  node scripts/setup-local.mjs prepare [--embedding local|external|gemini] [--oauth]
                                       [--embed-model MODEL] [--embed-url URL]
  node scripts/setup-local.mjs verify [--require-app] [--require-oauth] [--app-url URL] [--json]

Options:
  --repo PATH           Override repository root (mainly for isolated validation)
  --embedding PROFILE   Embedding profile for preflight (default: local)
  --embed-model MODEL   Local/external TEI model written by prepare
  --embed-url URL       Existing TEI root URL (required for external prepare)
  --oauth               Enable personal ChatGPT/Codex OAuth in a new .env
  --require-app          Require APP_URL/api/readyz during verify
  --require-oauth        Require the personal OAuth token store during verify
  --app-url URL          App origin for verify (default: ${DEFAULT_APP_URL})
  --json                 Emit machine-readable sanitized results
  -h, --help             Show this help

Safety:
  prepare never overwrites .env. No command installs system packages, changes
  Docker volumes, prints or exports token contents, or makes a model request.`;
}

export function parseArgs(argv) {
  const options = {
    command: "check",
    repoRoot: DEFAULT_REPO_ROOT,
    embedding: "local",
    embedModel: null,
    embedUrl: null,
    oauth: false,
    requireApp: false,
    requireOauth: false,
    appUrl: DEFAULT_APP_URL,
    json: false,
    help: false,
  };
  const args = [...argv];
  if (args[0] === "--") args.shift();
  if (args[0] && !args[0].startsWith("-")) options.command = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--oauth") options.oauth = true;
    else if (arg === "--require-app") options.requireApp = true;
    else if (arg === "--require-oauth") options.requireOauth = true;
    else if (arg === "--json") options.json = true;
    else if (["--repo", "--embedding", "--embed-model", "--embed-url", "--app-url"].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} requires a value`);
      if (arg === "--repo") options.repoRoot = resolve(value);
      if (arg === "--embedding") options.embedding = value;
      if (arg === "--embed-model") options.embedModel = value;
      if (arg === "--embed-url") options.embedUrl = value;
      if (arg === "--app-url") options.appUrl = value;
    } else {
      throw new UsageError(`unknown option: ${arg}`);
    }
  }
  if (!["check", "prepare", "verify", "help"].includes(options.command)) {
    throw new UsageError(`unknown command: ${options.command}`);
  }
  if (!["local", "external", "gemini"].includes(options.embedding)) {
    throw new UsageError(`invalid embedding profile: ${options.embedding}`);
  }
  if (options.embedModel && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(options.embedModel)) {
    throw new UsageError("--embed-model must be a safe Hugging Face model id");
  }
  if (options.embedUrl && !safeHttpUrl(options.embedUrl)) {
    throw new UsageError(`invalid --embed-url: ${options.embedUrl}`);
  }
  if (!safeHttpUrl(options.appUrl)) {
    throw new UsageError(`invalid --app-url: ${options.appUrl}`);
  }
  if (options.command === "prepare") {
    if (options.embedding === "external" && (!options.embedUrl || !options.embedModel)) {
      throw new UsageError("external prepare requires --embed-url and --embed-model");
    }
    if (options.embedding !== "external" && options.embedUrl) {
      throw new UsageError("--embed-url is only valid with --embedding external");
    }
    if (options.embedding === "gemini" && options.embedModel) {
      throw new UsageError("--embed-model is not valid with --embedding gemini");
    }
  }
  return options;
}

function parseQuotedValue(raw) {
  const value = raw.trim();
  if (value[0] !== `"` && value[0] !== `'`) return value.replace(/\s+#.*$/, "").trim();
  const quote = value[0];
  let escaped = false;
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (!escaped && ch === quote) return out;
    if (!escaped && ch === "\\") {
      escaped = true;
      continue;
    }
    out += ch;
    escaped = false;
  }
  return out;
}

export function parseEnvText(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (match) values.set(match[1], parseQuotedValue(match[2]));
  }
  return values;
}

function quoteEnv(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll(`"`, `\\"`)
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

export function setEnvValue(text, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:#\\s*)?${escapedKey}\\s*=`);
  const replacement = `${key}=${quoteEnv(value)}`;
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) lines.push(replacement);
  else lines[index] = replacement;
  return lines.join("\n");
}

export function prepareEnvText(template, options = {}) {
  const password = options.password ?? randomBytes(32).toString("hex");
  const authSecret = options.authSecret ?? randomBytes(48).toString("base64");
  const embedding = options.embedding ?? "local";
  if (!["local", "external", "gemini"].includes(embedding)) {
    throw new Error(`unsupported embedding profile: ${embedding}`);
  }
  if (embedding === "external" && !safeHttpUrl(options.embedUrl)) {
    throw new Error("external embedding profile requires a safe HTTP(S) embed URL");
  }
  let next = template;
  next = setEnvValue(next, "POSTGRES_PASSWORD", password);
  next = setEnvValue(
    next,
    "DATABASE_URL",
    `postgresql://jimi:${password}@127.0.0.1:5434/jimi?schema=public`,
  );
  next = setEnvValue(next, "AUTH_SECRET", authSecret);
  next = setEnvValue(next, "AUTH_MODE", "local");
  next = setEnvValue(next, "APP_URL", "http://localhost:3006");
  next = setEnvValue(next, "EMBED_DIM", "1024");
  if (embedding === "gemini") {
    next = setEnvValue(next, "EMBED_PROVIDER", "gemini");
    next = setEnvValue(next, "EMBED_BASE_URL", "");
    next = setEnvValue(next, "EMBED_MODEL", "gemini-embedding-001");
  } else {
    next = setEnvValue(next, "EMBED_PROVIDER", "local");
    next = setEnvValue(
      next,
      "EMBED_BASE_URL",
      embedding === "external" ? options.embedUrl : DEFAULT_LOCAL_EMBED_URL,
    );
    if (options.embedModel) next = setEnvValue(next, "EMBED_MODEL", options.embedModel);
  }
  if (options.oauth) {
    next = setEnvValue(next, "OPENAI_OAUTH_PERSONAL", "1");
    next = setEnvValue(next, "OPENAI_TRANSPORT", "oauth");
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function assertRepoRoot(repoRoot) {
  const packagePath = join(repoRoot, "package.json");
  const examplePath = join(repoRoot, ".env.example");
  if (!existsSync(packagePath) || !existsSync(examplePath)) {
    throw new Error(`jimi-wiki repository root not found: ${repoRoot}`);
  }
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (pkg.name !== "jimi-wiki-app") throw new Error(`unexpected package at repository root: ${pkg.name ?? "(none)"}`);
}

export function prepareEnvironment({
  repoRoot = DEFAULT_REPO_ROOT,
  oauth = false,
  embedding = "local",
  embedModel = null,
  embedUrl = null,
  password,
  authSecret,
} = {}) {
  assertRepoRoot(repoRoot);
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    throw new Error(`refusing to overwrite existing ${envPath}`);
  }
  const template = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const content = prepareEnvText(template, {
    oauth,
    embedding,
    embedModel,
    embedUrl,
    password,
    authSecret,
  });
  writeFileSync(envPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(envPath, 0o600);
  return {
    envPath,
    oauth,
    embedding,
    embedModel: embedding === "gemini" ? "gemini-embedding-001" : embedModel ?? DEFAULT_LOCAL_MODEL,
  };
}

function runProbe(command, args, options = {}) {
  const probe = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout ?? 5_000,
    env: options.env ?? process.env,
  });
  return {
    ok: probe.status === 0 && !probe.error,
    status: probe.status,
    output: `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim(),
    error: probe.error?.message,
  };
}

function result(id, status, message) {
  return { id, status, message };
}

export function evaluateNodeVersion(version) {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= 20;
}

function checkRepo(repoRoot) {
  try {
    assertRepoRoot(repoRoot);
    return result("repo", "pass", "jimi-wiki repository root detected");
  } catch (error) {
    return result("repo", "fail", error.message);
  }
}

function checkEnv(repoRoot, embedding) {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return [result("env", "warn", ".env is absent; run the prepare command before installation")];
  }
  const values = parseEnvText(readFileSync(envPath, "utf8"));
  const checks = [];
  const password = values.get("POSTGRES_PASSWORD") ?? "";
  const databaseUrl = values.get("DATABASE_URL") ?? "";
  const authSecret = values.get("AUTH_SECRET") ?? "";

  if (!password || password.includes("replace-with")) {
    checks.push(result("env.database", "fail", "POSTGRES_PASSWORD is missing or still a placeholder"));
  } else {
    try {
      const url = new URL(databaseUrl);
      const matches =
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.port === "5434" &&
        url.pathname === "/jimi" &&
        decodeURIComponent(url.password) === password;
      checks.push(
        result(
          "env.database",
          matches ? "pass" : "fail",
          matches
            ? "development DATABASE_URL matches POSTGRES_PASSWORD and loopback:5434/jimi"
            : "DATABASE_URL must match POSTGRES_PASSWORD and target loopback:5434/jimi",
        ),
      );
    } catch {
      checks.push(result("env.database", "fail", "DATABASE_URL is not a valid URL"));
    }
  }

  const authConfigured = authSecret.length >= 32 && !authSecret.includes("dev-secret");
  checks.push(
    result(
      "env.auth",
      authConfigured ? "pass" : "fail",
      authConfigured
        ? "AUTH_SECRET is configured"
        : "AUTH_SECRET is missing, too short, or still a development placeholder",
    ),
  );

  if (embedding === "local") {
    const provider = values.get("EMBED_PROVIDER");
    const base = values.get("EMBED_BASE_URL");
    const model = values.get("EMBED_MODEL") || DEFAULT_LOCAL_MODEL;
    const dim = values.get("EMBED_DIM") || "1024";
    const valid = provider === "local" && base === DEFAULT_LOCAL_EMBED_URL && dim === "1024";
    checks.push(
      result(
        "env.embedding",
        valid ? "pass" : "fail",
        valid
          ? `local embeddings configured (${model}, dim=${dim})`
          : `local embeddings require EMBED_PROVIDER=local, EMBED_BASE_URL=${DEFAULT_LOCAL_EMBED_URL}, and EMBED_DIM=1024`,
      ),
    );
  } else if (embedding === "external") {
    const provider = values.get("EMBED_PROVIDER");
    const base = values.get("EMBED_BASE_URL");
    const dim = values.get("EMBED_DIM") || "1024";
    const validBase = Boolean(base && safeHttpUrl(base));
    const valid = provider === "local" && validBase && dim === "1024";
    checks.push(
      result(
        "env.embedding",
        valid ? "pass" : "fail",
        valid
          ? `external TEI endpoint configured (${values.get("EMBED_MODEL") || DEFAULT_LOCAL_MODEL}, dim=${dim})`
          : "external TEI requires EMBED_PROVIDER=local, a safe HTTP(S) EMBED_BASE_URL, and EMBED_DIM=1024",
      ),
    );
  } else {
    const provider = values.get("EMBED_PROVIDER");
    const geminiKey = values.get("GEMINI_API_KEY");
    const dim = values.get("EMBED_DIM") || "1024";
    const valid = provider === "gemini" && Boolean(geminiKey) && dim === "1024";
    checks.push(
      result(
        "env.embedding",
        valid ? "pass" : "fail",
        valid
          ? "Gemini embeddings configured with a project-local credential and dim=1024"
          : "Gemini embeddings require EMBED_PROVIDER=gemini, GEMINI_API_KEY, and EMBED_DIM=1024",
      ),
    );
  }

  const oauth = values.get("OPENAI_TRANSPORT") === "oauth" || values.get("OPENAI_OAUTH_PERSONAL") === "1";
  if (oauth) {
    const configuredStore = values.get("OPENAI_OAUTH_STORE");
    const storePath = configuredStore
      ? isAbsolute(configuredStore)
        ? configuredStore
        : resolve(repoRoot, configuredStore)
      : join(repoRoot, ".openai-oauth.json");
    const store = inspectOauthStore(storePath);
    if (!store.valid) {
      checks.push(result("oauth.store", "warn", "personal OAuth is selected but its token store is missing or invalid"));
    } else {
      checks.push(
        result(
          "oauth.store",
          store.secure ? "pass" : "warn",
          store.secure
            ? "personal OAuth token store is structurally valid with owner-only permissions"
            : "personal OAuth token store exists but should have mode 0600",
        ),
      );
    }
  }
  return checks;
}

function inspectOauthStore(storePath) {
  if (!existsSync(storePath)) return { valid: false, secure: false };
  try {
    const stat = statSync(storePath);
    if (!stat.isFile()) return { valid: false, secure: false };
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    const valid =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.access === "string" &&
      parsed.access.length > 0 &&
      typeof parsed.refresh === "string" &&
      parsed.refresh.length > 0 &&
      typeof parsed.expires === "number" &&
      Number.isFinite(parsed.expires) &&
      parsed.expires > 0;
    return {
      valid,
      secure: valid && (process.platform === "win32" || (stat.mode & 0o777) === 0o600),
    };
  } catch {
    return { valid: false, secure: false };
  }
}

function prismaClientGenerated(repoRoot) {
  const generated = join(repoRoot, "src", "generated", "prisma");
  return ["index.js", "package.json", "schema.prisma"].every((name) => {
    const path = join(generated, name);
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

function dockerPortChecks(probe, embedding) {
  const checks = [];
  for (const [port, expected] of EXPECTED_CONTAINERS) {
    if (port === "8081" && embedding !== "local") continue;
    const owners = probe("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"]);
    if (!owners.ok) {
      checks.push(result(`port.${port}`, "warn", `could not inspect Docker owner of loopback port ${port}`));
      continue;
    }
    const names = owners.output.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    const foreign = names.filter((name) => name !== expected);
    let status;
    let message;
    if (foreign.length) {
      status = "fail";
      message = `port ${port} is published by unexpected container(s): ${foreign.join(", ")}`;
    } else if (names.includes(expected)) {
      status = "pass";
      message = `port ${port} is owned by expected container ${expected}`;
    } else {
      const ss = probe("ss", ["-ltnH", `sport = :${port}`]);
      const lsof = ss.ok
        ? null
        : probe("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      const occupied = ss.ok ? Boolean(ss.output) : lsof?.ok ? Boolean(lsof.output) : false;
      const confirmedFree = ss.ok || (lsof?.status === 1 && !lsof.output);
      status = occupied ? "fail" : confirmedFree ? "pass" : "warn";
      message = occupied
        ? `port ${port} is already used by a host listener outside Docker`
        : confirmedFree
          ? `port ${port} is available`
          : `could not confirm whether host port ${port} is available`;
    }
    checks.push(result(`port.${port}`, status, message));
  }
  return checks;
}

export function collectPreflight({
  repoRoot = DEFAULT_REPO_ROOT,
  embedding = "local",
  probe = runProbe,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [
    checkRepo(repoRoot),
    result(
      "node",
      evaluateNodeVersion(nodeVersion) ? "pass" : "fail",
      evaluateNodeVersion(nodeVersion) ? `Node ${nodeVersion}` : `Node 20+ required (found ${nodeVersion})`,
    ),
  ];

  const pnpm = probe("corepack", ["pnpm", "--version"], { cwd: repoRoot });
  const directPnpm = pnpm.ok ? null : probe("pnpm", ["--version"], { cwd: repoRoot });
  checks.push(
    result(
      "pnpm",
      pnpm.ok || directPnpm?.ok ? "pass" : "fail",
      pnpm.ok
        ? `Corepack pnpm ${pnpm.output.split(/\s+/)[0]}`
        : directPnpm?.ok
          ? `pnpm ${directPnpm.output.split(/\s+/)[0]} (Corepack unavailable)`
          : "Corepack/pnpm is unavailable",
    ),
  );

  const docker = probe("docker", ["version", "--format", "{{.Server.Version}}"]);
  checks.push(
    result("docker", docker.ok ? "pass" : "fail", docker.ok ? `Docker server ${docker.output}` : "Docker daemon unavailable"),
  );
  const compose = probe("docker", ["compose", "version", "--short"]);
  checks.push(
    result("compose", compose.ok ? "pass" : "fail", compose.ok ? `Docker Compose ${compose.output}` : "docker compose unavailable"),
  );

  if (embedding === "local") {
    checks.push(
      result(
        "platform",
        platform === "linux" && arch === "x64" ? "pass" : "fail",
        platform === "linux" && arch === "x64"
          ? "x86_64 Linux/WSL local-embedding host"
          : `local embeddings currently require x86_64 Linux/WSL (found ${platform}/${arch})`,
      ),
    );
    const gpu = probe("nvidia-smi", ["-L"]);
    const runtimes = probe("docker", ["info", "--format", "{{json .Runtimes}}"]);
    checks.push(
      result(
        "gpu",
        gpu.ok && /nvidia/i.test(runtimes.output) ? "pass" : "fail",
        gpu.ok && /nvidia/i.test(runtimes.output)
          ? "NVIDIA GPU and Docker NVIDIA runtime detected"
          : "local embeddings require nvidia-smi and a Docker NVIDIA runtime",
      ),
    );
  }

  if (docker.ok) checks.push(...dockerPortChecks(probe, embedding));

  try {
    const fs = statfsSync(repoRoot, { bigint: true });
    const free = fs.bavail * fs.bsize;
    const freeGiB = Number((free * 10n) / GIB) / 10;
    checks.push(
      result(
        "disk",
        free >= 12n * GIB ? "pass" : "warn",
        `${freeGiB.toFixed(1)} GiB free${free >= 12n * GIB ? "" : "; about 12 GiB is recommended for image, model, and packages"}`,
      ),
    );
  } catch {
    checks.push(result("disk", "warn", "could not determine free disk space"));
  }

  checks.push(...checkEnv(repoRoot, embedding));
  const prismaGenerated = prismaClientGenerated(repoRoot);
  checks.push(
    result(
      "prisma.client",
      prismaGenerated ? "pass" : "warn",
      prismaGenerated
        ? "generated Prisma client is present"
        : "generated Prisma client is absent; run corepack pnpm exec prisma generate",
    ),
  );
  return checks;
}

function addVerifyResult(checks, id, ok, passMessage, failMessage) {
  checks.push(result(id, ok ? "pass" : "fail", ok ? passMessage : failMessage));
}

async function verifyRuntime(options) {
  const checks = collectPreflight(options);
  const db = runProbe("docker", ["inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", "jimi-wiki-dev-db"]);
  addVerifyResult(checks, "runtime.database", db.ok && db.output === "healthy", "development PostgreSQL is healthy", "development PostgreSQL is not healthy");

  const migrations = runProbe("docker", [
    "exec",
    "jimi-wiki-dev-db",
    "psql",
    "-U",
    "jimi",
    "-d",
    "jimi",
    "-Atc",
    `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  ]);
  const migrationCount = Number(migrations.output);
  addVerifyResult(
    checks,
    "runtime.migrations",
    migrations.ok && Number.isInteger(migrationCount) && migrationCount > 0,
    `${migrationCount} Prisma migration(s) applied`,
    "could not verify applied Prisma migrations",
  );

  const envPath = join(options.repoRoot, ".env");
  const values = existsSync(envPath) ? parseEnvText(readFileSync(envPath, "utf8")) : new Map();
  if (options.embedding === "local" || options.embedding === "external") {
    const base = values.get("EMBED_BASE_URL") || DEFAULT_LOCAL_EMBED_URL;
    const expectedModel = values.get("EMBED_MODEL") || DEFAULT_LOCAL_MODEL;
    const endpoint = safeHttpUrl(base);
    if (!endpoint) {
      addVerifyResult(checks, "runtime.embedding", false, "", "TEI embedding endpoint URL is invalid");
      addVerifyResult(
        checks,
        "runtime.embedding-model",
        false,
        "",
        `TEI embedding endpoint does not report configured model ${expectedModel}`,
      );
    } else {
      const origin = endpoint.toString().replace(/\/+$/, "");
      try {
        const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
        addVerifyResult(
          checks,
          "runtime.embedding",
          health.ok,
          "TEI embedding endpoint is healthy",
          "TEI embedding endpoint is not healthy",
        );
      } catch {
        addVerifyResult(checks, "runtime.embedding", false, "", "TEI embedding endpoint is unreachable");
      }
      try {
        const infoResponse = await fetch(`${origin}/info`, { signal: AbortSignal.timeout(5_000) });
        const info = infoResponse.ok ? await infoResponse.json() : {};
        const served = info.model_id ?? info.served_model_name;
        addVerifyResult(
          checks,
          "runtime.embedding-model",
          infoResponse.ok && served === expectedModel,
          `TEI embedding endpoint serves ${expectedModel}`,
          `TEI embedding endpoint does not report configured model ${expectedModel}`,
        );
      } catch {
        addVerifyResult(
          checks,
          "runtime.embedding-model",
          false,
          "",
          `TEI embedding endpoint does not report configured model ${expectedModel}`,
        );
      }
    }
  }

  if (options.requireApp) {
    try {
      const ready = await fetch(`${options.appUrl.replace(/\/+$/, "")}/api/readyz`, { signal: AbortSignal.timeout(5_000) });
      const body = ready.ok ? await ready.json() : {};
      addVerifyResult(checks, "runtime.app", ready.ok && body.ok === true, `${options.appUrl}/api/readyz is ready`, `${options.appUrl}/api/readyz is not ready`);
    } catch {
      addVerifyResult(checks, "runtime.app", false, "", `${options.appUrl}/api/readyz is unreachable`);
    }
  }

  if (options.requireOauth) {
    const configuredStore = values.get("OPENAI_OAUTH_STORE");
    const storePath = configuredStore
      ? isAbsolute(configuredStore)
        ? configuredStore
        : resolve(options.repoRoot, configuredStore)
      : join(options.repoRoot, ".openai-oauth.json");
    const store = inspectOauthStore(storePath);
    addVerifyResult(
      checks,
      "runtime.oauth",
      store.valid && store.secure,
      "personal OAuth token store is structurally valid with owner-only permissions",
      "required personal OAuth token store is missing, invalid, or not mode 0600",
    );
  }
  return checks;
}

function printChecks(checks, json) {
  if (json) {
    console.log(JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2));
    return;
  }
  for (const check of checks) {
    console.log(`${check.status.toUpperCase().padEnd(4)}  ${check.id.padEnd(24)} ${check.message}`);
  }
  const pass = checks.filter((check) => check.status === "pass").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  console.log(`\nSummary: ${pass} pass, ${warn} warn, ${fail} fail`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || options.command === "help") {
      console.log(usage());
      return;
    }
    if (options.command === "prepare") {
      const prepared = prepareEnvironment(options);
      console.log(`Created ${prepared.envPath} with mode 0600.`);
      console.log(`Embedding profile: ${prepared.embedding}`);
      console.log(`Embedding model: ${prepared.embedModel}`);
      console.log(`Personal OAuth bootstrap: ${prepared.oauth ? "enabled" : "disabled"}`);
      if (prepared.embedding === "gemini") {
        console.log("Gemini credential: add GEMINI_API_KEY to .env without putting it in shell history.");
      }
      console.log("Secrets were generated locally and are not printed.");
      console.log("\nNext: install dependencies, generate Prisma, start Docker services, and apply migrations.");
      return;
    }
    const checks =
      options.command === "verify" ? await verifyRuntime(options) : collectPreflight(options);
    printChecks(checks, options.json);
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    console.error(`setup-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
