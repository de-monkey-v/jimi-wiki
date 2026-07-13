import { createHash } from "node:crypto";

type Jsonish = null | boolean | number | string | Jsonish[] | { [key: string]: Jsonish };

function canonicalize(value: unknown): Jsonish {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return String(value);
}

export function canonicalContentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export interface PageHashSnapshot {
  title: string;
  body: string;
  kind: string;
  frontmatter: unknown;
  category: string | null;
  parentId: string | null;
  sortOrder: number;
  sourceId: string | null;
  origin: string;
  modelAccess: string;
  archivedAt: Date | string | null;
  suppressedAt: Date | string | null;
  staleAt: Date | string | null;
}

export function pageSnapshotHash(snapshot: PageHashSnapshot): string {
  return canonicalContentHash(snapshot);
}

export interface SourceHashSnapshot {
  title: string;
  url: string | null;
  body: string | null;
  storageKey: string | null;
  modelAccess: string;
  archivedAt: Date | string | null;
}

export function sourceSnapshotHash(snapshot: SourceHashSnapshot): string {
  return canonicalContentHash(snapshot);
}
