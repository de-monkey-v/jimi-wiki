import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const PRESERVED_TABLES = [
  "AppConfig", "User", "UsageEvent", "Wiki", "Membership", "ShareLink",
  "Page", "PageRevision", "PageRevisionSource", "PageTranslation", "PageLink",
  "Source", "SourceRevision", "PageContribution", "ConceptRelation", "SearchChunk",
  "LogEntry", "AgentRun", "KnowledgeBuild", "SourceExtraction", "KnowledgeBuildExtraction",
  "KnowledgeDraft", "KnowledgeDraftSource", "KnowledgeBuildPageRevision",
  "PagePin", "FolderPin", "SavedLink", "TelegramBinding", "TelegramTurn",
] as const;

export type ContentManifest = {
  format: "jimi-content-manifest-v1";
  generatedAt: string;
  tables: Record<string, { rows: number; sha256: string }>;
  blobs: {
    files: Record<string, { bytes: number; sha256: string }>;
    referencedKeys: string[];
    missingReferencedKeys: string[];
  };
};

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(dir: string, prefix = "", out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listFiles(dir, relative, out);
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

async function tableDigest(client: Client, table: string, where = ""): Promise<{ rows: number; sha256: string }> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const result = await client.query<{ row: string }>(
    `SELECT to_jsonb(t)::text AS row FROM "${table}" t ${where} ORDER BY to_jsonb(t)::text`,
  );
  const hash = createHash("sha256");
  for (const { row } of result.rows) hash.update(row).update("\n");
  return { rows: result.rowCount ?? result.rows.length, sha256: hash.digest("hex") };
}

export async function buildContentManifest(opts?: {
  databaseUrl?: string;
  blobDir?: string;
}): Promise<ContentManifest> {
  const databaseUrl = opts?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const blobDir = path.resolve(opts?.blobDir ?? process.env.BLOB_DIR ?? path.join(process.cwd(), ".blobs"));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tables: ContentManifest["tables"] = {};
    for (const table of PRESERVED_TABLES) tables[table] = await tableDigest(client, table);
    // 사용된 invite는 감사 기록으로 보존하고 unused invite만 reset 대상이다.
    tables["Invite(used)"] = await tableDigest(client, "Invite", 'WHERE "usedAt" IS NOT NULL');

    const referenced = await client.query<{ storageKey: string }>(`
      SELECT "storageKey" FROM "Source" WHERE "storageKey" IS NOT NULL
      UNION
      SELECT "storageKey" FROM "SourceRevision" WHERE "storageKey" IS NOT NULL
      ORDER BY "storageKey"
    `);
    const referencedKeys = referenced.rows.map((row) => row.storageKey);
    const files: ContentManifest["blobs"]["files"] = {};
    for (const relative of (await listFiles(blobDir)).sort()) {
      const absolute = path.resolve(blobDir, relative);
      if (!absolute.startsWith(`${blobDir}${path.sep}`)) throw new Error(`Blob path escaped root: ${relative}`);
      const info = await stat(absolute);
      files[relative] = { bytes: info.size, sha256: await sha256File(absolute) };
    }
    return {
      format: "jimi-content-manifest-v1",
      generatedAt: new Date().toISOString(),
      tables,
      blobs: {
        files,
        referencedKeys,
        missingReferencedKeys: referencedKeys.filter((key) => !files[key]),
      },
    };
  } finally {
    await client.end();
  }
}

export function comparableManifest(manifest: ContentManifest) {
  return { format: manifest.format, tables: manifest.tables, blobs: manifest.blobs };
}

export function assertManifestEqual(actual: ContentManifest, expected: ContentManifest): void {
  const a = JSON.stringify(comparableManifest(actual));
  const b = JSON.stringify(comparableManifest(expected));
  if (a !== b) throw new Error("Content manifest mismatch");
  if (actual.blobs.missingReferencedKeys.length > 0) {
    throw new Error(`Missing referenced blobs: ${actual.blobs.missingReferencedKeys.join(", ")}`);
  }
}

export async function readManifest(file: string): Promise<ContentManifest> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as ContentManifest;
  if (parsed.format !== "jimi-content-manifest-v1") throw new Error(`Unsupported manifest: ${file}`);
  return parsed;
}

export async function writeManifest(file: string, manifest: ContentManifest): Promise<void> {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temp = `${absolute}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, absolute);
}
