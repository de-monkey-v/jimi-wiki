import "server-only";
import { prisma } from "@/lib/db";
import { fetchLinkMeta } from "@/lib/ingest";
import { trashPurgeAt } from "@/lib/trash";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
]);

export const SAVED_LINK_SUMMARY_MAX = 2_000;

export function normalizeSavedLinkUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid_url");

  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? parsed.toString() : value;
}

export function normalizeSavedLinkSummary(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new Error("invalid_summary");
  const summary = raw.trim();
  if (!summary) return null;
  if (summary.length > SAVED_LINK_SUMMARY_MAX) throw new Error("summary_too_large");
  return summary;
}

const savedLinkSelect = {
  id: true,
  url: true,
  title: true,
  description: true,
  summary: true,
  trashedAt: true,
  purgeAt: true,
  promotedAt: true,
  promotedRunId: true,
  promotedRun: { select: { status: true, error: true } },
  createdAt: true,
} as const;

export async function saveSavedLink(input: {
  wikiId: string;
  userId: string;
  url: string;
  summary?: unknown;
}) {
  const url = normalizeSavedLinkUrl(input.url);
  const summary = normalizeSavedLinkSummary(input.summary);
  const existing = await prisma.savedLink.findFirst({
    where: { wikiId: input.wikiId, userId: input.userId, url },
    select: savedLinkSelect,
  });
  if (existing) {
    const restored = existing.trashedAt !== null;
    const summaryChanged = summary !== null && summary !== existing.summary;
    if (!restored && !summaryChanged) return { link: existing, existing: true, restored: false, updated: false };
    const link = await prisma.savedLink.update({
      where: { id: existing.id },
      data: {
        ...(restored ? { trashedAt: null, purgeAt: null, createdAt: new Date() } : {}),
        ...(summaryChanged ? { summary } : {}),
      },
      select: savedLinkSelect,
    });
    return { link, existing: true, restored, updated: summaryChanged };
  }

  const meta = await fetchLinkMeta(url);
  const link = await prisma.savedLink.create({
    data: {
      userId: input.userId,
      wikiId: input.wikiId,
      url,
      title: meta.title,
      description: meta.description,
      summary,
    },
    select: savedLinkSelect,
  });
  return { link, existing: false, restored: false, updated: false };
}

export async function trashSavedLink(wikiId: string, userId: string, id: string, now = new Date()) {
  const current = await prisma.savedLink.findFirst({ where: { id, wikiId, userId }, select: savedLinkSelect });
  if (!current) throw new Error("saved_link_not_found");
  if (current.trashedAt) return { link: current, trashed: true, existing: true };
  const link = await prisma.savedLink.update({
    where: { id: current.id },
    data: { trashedAt: now, purgeAt: trashPurgeAt(now) },
    select: savedLinkSelect,
  });
  return { link, trashed: true, existing: false };
}

export async function restoreSavedLink(wikiId: string, userId: string, id: string) {
  const current = await prisma.savedLink.findFirst({ where: { id, wikiId, userId }, select: savedLinkSelect });
  if (!current) throw new Error("saved_link_not_found");
  if (!current.trashedAt) return { link: current, restored: false };
  const link = await prisma.savedLink.update({
    where: { id: current.id },
    data: { trashedAt: null, purgeAt: null },
    select: savedLinkSelect,
  });
  return { link, restored: true };
}
