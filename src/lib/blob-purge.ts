import "server-only";
import { prisma } from "@/lib/db";
import { getBlobStore } from "@/lib/blob";

export const BLOB_PURGE_PENDING_TITLE = "purge blob cleanup pending";
export const BLOB_PURGE_COMPLETE_TITLE = "purge blob cleanup complete";

type BlobPurgePayload = {
  version: 1;
  sourceSlug: string;
  storageKeys: string[];
  attempts: number;
  lastError?: string;
  completedAt?: string;
};

export function blobPurgePayload(sourceSlug: string, storageKeys: string[]): string {
  return JSON.stringify({
    version: 1,
    sourceSlug,
    storageKeys: [...new Set(storageKeys.filter(Boolean))],
    attempts: 0,
  } satisfies BlobPurgePayload);
}

function parsePayload(raw: string): BlobPurgePayload {
  const value = JSON.parse(raw) as Partial<BlobPurgePayload>;
  if (
    value.version !== 1 ||
    typeof value.sourceSlug !== "string" ||
    !Array.isArray(value.storageKeys) ||
    value.storageKeys.some((key) => typeof key !== "string") ||
    !Number.isSafeInteger(value.attempts) ||
    Number(value.attempts) < 0
  ) {
    throw new Error("invalid blob purge payload");
  }
  return value as BlobPurgePayload;
}

/**
 * Source row가 사라진 뒤에도 exact storage key를 durable LogEntry에 남겨 재시도한다.
 * delete는 idempotent하므로 route와 worker가 경합해도 안전하다.
 */
export async function processBlobPurgeLog(logId: string): Promise<{ completed: boolean; remaining: number }> {
  const log = await prisma.logEntry.findUnique({
    where: { id: logId },
    select: { id: true, wikiId: true, title: true, detail: true },
  });
  if (!log || log.title === BLOB_PURGE_COMPLETE_TITLE) return { completed: true, remaining: 0 };
  if (log.title !== BLOB_PURGE_PENDING_TITLE) throw new Error("not a pending blob purge log");
  const payload = parsePayload(log.detail);
  const prefix = `${log.wikiId}/`;
  if (payload.storageKeys.some((key) => !key.startsWith(prefix))) {
    throw new Error("blob purge key is outside its wiki prefix");
  }

  const settled = await Promise.allSettled(payload.storageKeys.map((key) => getBlobStore().delete(key)));
  const failedKeys = payload.storageKeys.filter((_, index) => settled[index]?.status === "rejected");
  const attempts = payload.attempts + 1;
  if (failedKeys.length === 0) {
    await prisma.logEntry.updateMany({
      where: { id: log.id, title: BLOB_PURGE_PENDING_TITLE },
      data: {
        title: BLOB_PURGE_COMPLETE_TITLE,
        detail: JSON.stringify({
          version: 1,
          sourceSlug: payload.sourceSlug,
          storageKeys: [],
          attempts,
          completedAt: new Date().toISOString(),
        } satisfies BlobPurgePayload),
      },
    });
    return { completed: true, remaining: 0 };
  }

  const firstFailure = settled.find((result) => result.status === "rejected");
  await prisma.logEntry.updateMany({
    where: { id: log.id, title: BLOB_PURGE_PENDING_TITLE },
    data: {
      detail: JSON.stringify({
        version: 1,
        sourceSlug: payload.sourceSlug,
        storageKeys: failedKeys,
        attempts,
        lastError: firstFailure?.status === "rejected"
          ? String(firstFailure.reason instanceof Error ? firstFailure.reason.message : firstFailure.reason).slice(0, 500)
          : "unknown cleanup failure",
      } satisfies BlobPurgePayload),
    },
  });
  return { completed: false, remaining: failedKeys.length };
}

/** worker poll용 bounded retry. 한 번 실패한 job도 다음 poll에서 계속 재시도한다. */
export async function processPendingBlobPurges(limit = 10): Promise<number> {
  const jobs = await prisma.logEntry.findMany({
    where: { title: BLOB_PURGE_PENDING_TITLE },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(100, Math.trunc(limit) || 10)),
    select: { id: true },
  });
  for (const job of jobs) await processBlobPurgeLog(job.id).catch(() => null);
  return jobs.length;
}
