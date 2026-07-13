import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import { normalizeSlug } from "@/lib/markdown";
import { modelAccessForKind, stricterModelAccess } from "@/lib/content-policy";
import { ONTOLOGY_PAGE_SLUG } from "@/lib/wiki-routes";
import type { ToolSpec } from "@/lib/gemini";
import type { ModelAccess, PageKind, Prisma } from "@/generated/prisma/client";

/**
 * 외부 모델이 읽을 수 있는 데이터 범위를 호출부가 명시하게 하는 capability token.
 * 향후 내부 모델 adapter가 생기기 전까지는 external만 지원한다.
 */
export const EXTERNAL_MODEL_SCOPE = Object.freeze({ trust: "external" as const });
export type ExternalModelScope = typeof EXTERNAL_MODEL_SCOPE;
export type ModelAccessValue = ModelAccess;

export function assertExternalModelScope(scope: ExternalModelScope): void {
  if (!scope || scope.trust !== "external") throw new Error("지원하지 않는 모델 trust scope");
}

/** personal은 입력값과 무관하게 항상 internalOnly다. */
export function normalizeModelAccess(
  kind: PageKind,
  requested: ModelAccessValue | null | undefined,
): ModelAccessValue {
  return modelAccessForKind(kind, requested ?? "external");
}

/** 복원·provenance 전파에서 더 엄격한 정책만 남긴다. */
export function strictestModelAccess(
  a: ModelAccessValue | null | undefined,
  b: ModelAccessValue | null | undefined,
): ModelAccessValue {
  return stricterModelAccess(a, b);
}

export function isExternalModelEligible(doc: {
  modelAccess: ModelAccessValue;
  archivedAt?: Date | null;
  kind?: PageKind;
}): boolean {
  return doc.modelAccess === "external" && doc.archivedAt == null && doc.kind !== "personal";
}

const MODEL_POLICY_LOCK_PREFIX = "jimi:model-policy:";
// PrismaPg의 기본 pg pool(max=10)을 shared model dispatch만으로 다 쓰지 않도록 4개 연결을
// 일반 요청·policy downgrade에 남긴다. 프로세스별 pool/semaphore라 다중 인스턴스에도 비율이 유지된다.
export const MODEL_POLICY_MAX_CONCURRENT_DISPATCHES = Math.min(
  6,
  Math.max(1, Math.trunc(Number(process.env.MODEL_POLICY_MAX_CONCURRENT_DISPATCHES)) || 6),
);

let activeModelDispatches = 0;
const pendingModelDispatches: Array<() => void> = [];

async function acquireModelDispatchPermit(deadlineAt: number): Promise<() => void> {
  if (activeModelDispatches < MODEL_POLICY_MAX_CONCURRENT_DISPATCHES) {
    activeModelDispatches++;
  } else {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new ModelPolicyLeaseExpiredError();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      pendingModelDispatches.push(grant);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = pendingModelDispatches.indexOf(grant);
        if (index >= 0) pendingModelDispatches.splice(index, 1);
        reject(new ModelPolicyLeaseExpiredError());
      }, remainingMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = pendingModelDispatches.shift();
    if (next) next(); // active slot을 다음 waiter에게 직접 인계한다.
    else activeModelDispatches--;
  };
}

type ModelPolicyLockMode = "shared" | "exclusive";
type ModelPolicyLockContext = {
  wikiId: string;
  mode: ModelPolicyLockMode;
  tx: Prisma.TransactionClient;
  lease: ModelPolicyDispatchLease;
};

export const MODEL_POLICY_TRANSACTION_TIMEOUT_MS = 300_000;
export const MODEL_POLICY_LEASE_SAFETY_MARGIN_MS = 60_000;
export const MODEL_POLICY_DISPATCH_LEASE_MS =
  MODEL_POLICY_TRANSACTION_TIMEOUT_MS - MODEL_POLICY_LEASE_SAFETY_MARGIN_MS;
// shared reader는 lock 대기를 provider lease 안에 끝내고, exclusive writer는 active shared
// lease(240s)가 abort/unwind할 시간을 준 뒤에도 lock을 얻을 수 있어야 한다.
export const MODEL_POLICY_SHARED_LOCK_TIMEOUT_MS = MODEL_POLICY_DISPATCH_LEASE_MS - 1_000;
export const MODEL_POLICY_WRITE_LEASE_MS = MODEL_POLICY_TRANSACTION_TIMEOUT_MS - 15_000;
export const MODEL_POLICY_WRITE_LOCK_TIMEOUT_MS = MODEL_POLICY_WRITE_LEASE_MS - 1_000;

export class ModelPolicyLeaseExpiredError extends Error {
  readonly code = "MODEL_POLICY_LEASE_EXPIRED";

  constructor() {
    super("external model dispatch lease expired before policy transaction timeout");
    this.name = "ModelPolicyLeaseExpiredError";
  }
}

export type ModelPolicyDispatchLease = {
  signal: AbortSignal;
  deadlineAt: number;
  assertActive: () => void;
  dispose: () => void;
};

/**
 * Provider dispatch를 interactive transaction timeout보다 60초 먼저 중단한다. Prisma timeout은
 * 실행 중인 JS callback을 abort하지 않으므로, 이 별도 absolute lease가 모든 provider turn에
 * 같은 AbortSignal을 공급해 advisory lock이 풀린 뒤 후속 payload가 나가지 않게 한다.
 */
export function createModelPolicyDispatchLease(
  durationMs = MODEL_POLICY_DISPATCH_LEASE_MS,
): ModelPolicyDispatchLease {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("model policy lease duration must be positive");
  const controller = new AbortController();
  const deadlineAt = Date.now() + durationMs;
  const timer = setTimeout(() => controller.abort(new ModelPolicyLeaseExpiredError()), durationMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    signal: controller.signal,
    deadlineAt,
    assertActive: () => controller.signal.throwIfAborted(),
    dispose: () => {
      clearTimeout(timer);
      if (!controller.signal.aborted) {
        controller.abort(new Error("model policy dispatch lease closed with its policy transaction"));
      }
    },
  };
}

/**
 * 같은 요청의 model-policy 경계 안에서 호출된 loader/search/tool이 별도 Prisma 연결을
 * 빌리지 않도록 현재 interactive transaction을 전파한다. shared -> exclusive 승격은
 * PostgreSQL advisory lock upgrade 교착을 만들 수 있으므로 명시적으로 거부한다.
 */
const modelPolicyLockStorage = new AsyncLocalStorage<ModelPolicyLockContext>();

export function modelPolicyClient(wikiId: string): Prisma.TransactionClient {
  const current = modelPolicyLockStorage.getStore();
  if (current?.wikiId === wikiId) {
    current.lease.assertActive();
    return current.tx;
  }
  return prisma;
}

/** 현재 wiki policy lock의 absolute provider AbortSignal. lock 밖 호출은 fail-closed다. */
export function modelPolicyDispatchSignal(wikiId: string): AbortSignal {
  const current = modelPolicyLockStorage.getStore();
  if (!current || current.wikiId !== wikiId) {
    throw new Error("external model dispatch requires an active model policy lock");
  }
  if (current.mode !== "shared") {
    throw new Error("external model dispatch is not allowed inside a policy write transaction");
  }
  current.lease.assertActive();
  return current.lease.signal;
}

/** SDK별 request timeout에 쓸 현재 lease 잔여시간. 최소 1ms, 만료면 throw. */
export function modelPolicyDispatchRemainingMs(wikiId: string): number {
  const current = modelPolicyLockStorage.getStore();
  if (!current || current.wikiId !== wikiId) {
    throw new Error("external model dispatch requires an active model policy lock");
  }
  if (current.mode !== "shared") {
    throw new Error("external model dispatch is not allowed inside a policy write transaction");
  }
  current.lease.assertActive();
  return Math.max(1, current.lease.deadlineAt - Date.now());
}

export async function acquireExternalModelPolicyReadLockTx(
  tx: Prisma.TransactionClient,
  wikiId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
    `${MODEL_POLICY_LOCK_PREFIX}${wikiId}`,
  );
}

async function withModelPolicyLock<T>(
  wikiId: string,
  mode: ModelPolicyLockMode,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const current = modelPolicyLockStorage.getStore();
  if (current?.wikiId === wikiId) {
    current.lease.assertActive();
    if (mode === "exclusive" && current.mode === "shared") {
      throw new Error("model policy shared lock cannot be upgraded to exclusive in the same request");
    }
    return fn(current.tx);
  }
  // shared dispatch의 absolute budget은 semaphore 대기 전부터 시작한다. 오래 대기한 요청이
  // permit을 받은 뒤 새 240초 budget으로 provider 비용을 발생시키는 deadline reset을 막는다.
  const sharedDeadlineAt = mode === "shared" ? Date.now() + MODEL_POLICY_DISPATCH_LEASE_MS : null;
  const releasePermit = sharedDeadlineAt ? await acquireModelDispatchPermit(sharedDeadlineAt) : null;
  try {
    return await prisma.$transaction(
      async (tx) => {
        // Prisma transaction timeout은 callback 시작부터 흐른다. lease도 advisory lock을 기다리기
        // 전에 시작해야, 오래 기다린 뒤 새 lease로 provider를 보내는 deadline reset을 막을 수 있다.
        const remainingSharedMs = sharedDeadlineAt === null
          ? null
          : sharedDeadlineAt - Date.now();
        if (remainingSharedMs !== null && remainingSharedMs <= 0) {
          throw new ModelPolicyLeaseExpiredError();
        }
        const lease = createModelPolicyDispatchLease(
          remainingSharedMs ?? MODEL_POLICY_WRITE_LEASE_MS,
        );
        try {
          const lockTimeout = mode === "shared"
            ? Math.max(1, Math.min(MODEL_POLICY_SHARED_LOCK_TIMEOUT_MS, (remainingSharedMs ?? 1) - 1))
            : MODEL_POLICY_WRITE_LOCK_TIMEOUT_MS;
          await tx.$executeRawUnsafe(
            `SET LOCAL lock_timeout = '${lockTimeout}ms'`,
          );
          if (mode === "shared") await acquireExternalModelPolicyReadLockTx(tx, wikiId);
          else {
            await tx.$executeRawUnsafe(
              "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
              `${MODEL_POLICY_LOCK_PREFIX}${wikiId}`,
            );
          }
          lease.assertActive();
          return await modelPolicyLockStorage.run({ wikiId, mode, tx, lease }, () => fn(tx));
        } finally {
          lease.dispose();
        }
      },
      { maxWait: 15_000, timeout: MODEL_POLICY_TRANSACTION_TIMEOUT_MS },
    );
  } finally {
    releasePermit?.();
  }
}

/** 외부 payload 선택부터 dispatch 완료까지 정책 downgrade와 직렬화한다. */
export function withExternalModelDispatchLock<T>(
  wikiId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withModelPolicyLock(wikiId, "shared", fn);
}

/** 정책 변경 서비스가 같은 키로 exclusive lock을 잡을 수 있게 공개한다. */
export function withModelPolicyWriteLock<T>(
  wikiId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withModelPolicyLock(wikiId, "exclusive", fn);
}

/** 모델 도구·번역용 active external Page loader. 일반 UI/REST 권한 조회와 분리한다. */
export function listModelPages(wikiId: string, scope: ExternalModelScope) {
  assertExternalModelScope(scope);
  return modelPolicyClient(wikiId).page.findMany({
    where: {
      wikiId,
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
      slug: { not: ONTOLOGY_PAGE_SLUG },
    },
    orderBy: { title: "asc" },
  });
}

export function getModelPage(wikiId: string, slug: string, scope: ExternalModelScope) {
  assertExternalModelScope(scope);
  return modelPolicyClient(wikiId).page.findFirst({
    where: {
      wikiId,
      slug: { equals: normalizeSlug(slug), not: ONTOLOGY_PAGE_SLUG },
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
    },
  });
}

export function getModelPageById(wikiId: string, pageId: string, scope: ExternalModelScope) {
  assertExternalModelScope(scope);
  return modelPolicyClient(wikiId).page.findFirst({
    where: {
      id: pageId,
      wikiId,
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
      slug: { not: ONTOLOGY_PAGE_SLUG },
    },
  });
}

export function getModelSource(wikiId: string, slug: string, scope: ExternalModelScope) {
  assertExternalModelScope(scope);
  return modelPolicyClient(wikiId).source.findFirst({
    where: { wikiId, slug: normalizeSlug(slug), archivedAt: null, modelAccess: "external" },
  });
}

export async function getModelSourcesByIds(
  wikiId: string,
  ids: string[],
  scope: ExternalModelScope,
): Promise<{ id: string; slug: string; title: string }[]> {
  assertExternalModelScope(scope);
  if (ids.length === 0) return [];
  return modelPolicyClient(wikiId).source.findMany({
    where: { wikiId, id: { in: ids }, archivedAt: null, modelAccess: "external" },
    select: { id: true, slug: true, title: true },
  });
}

/**
 * 외부 모델이 볼 수 있는 active Page가 실제로 사용하는 category와 그 조상 경로.
 * 온톨로지 projection 자체는 internalOnly 문서에서 유래했을 수 있으므로, 모델 경계에서는
 * projection의 전체 목록을 신뢰하지 않고 이 집합을 allow-list로 사용한다.
 */
export async function externalCategorySlugs(
  wikiId: string,
  scope: ExternalModelScope = EXTERNAL_MODEL_SCOPE,
): Promise<Set<string>> {
  assertExternalModelScope(scope);
  const rows = await modelPolicyClient(wikiId).page.findMany({
    where: {
      wikiId,
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
      category: { not: null },
    },
    select: { category: true },
    distinct: ["category"],
  });
  const allowed = new Set<string>();
  for (const row of rows) {
    const parts = row.category?.split("/").filter(Boolean) ?? [];
    for (let i = 1; i <= parts.length; i++) allowed.add(parts.slice(0, i).join("/"));
  }
  return allowed;
}

export interface ExternalModelCategory {
  slug: string;
  label: string;
  itemCount: number;
}

function safeCategoryScore(query: string, slug: string): number {
  const terms = (value: string) => value
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, " ")
    .replace(/[^a-z0-9가-힣 ]/g, "")
    .split(" ")
    .filter(Boolean);
  const q = terms(query);
  const c = terms(slug);
  if (!q.length || !c.length) return 0;
  const qs = q.join(" ");
  const cs = c.join(" ");
  if (qs === cs) return 1;
  if (qs.includes(cs) || cs.includes(qs)) return 0.85;
  const qa = new Set(q);
  const ca = new Set(c);
  let overlap = 0;
  for (const term of qa) if (ca.has(term)) overlap++;
  return overlap / (qa.size + ca.size - overlap);
}

/**
 * 저장된 ontology label/synonym은 internalOnly 문서에서 유래했을 가능성을 역추적할 수 없다.
 * 따라서 외부 모델에는 external Page의 category 경로만으로 결정론적으로 다시 만든 projection을 준다.
 */
export async function listExternalModelCategories(
  wikiId: string,
  scope: ExternalModelScope = EXTERNAL_MODEL_SCOPE,
): Promise<ExternalModelCategory[]> {
  assertExternalModelScope(scope);
  const rows = await modelPolicyClient(wikiId).page.findMany({
    where: {
      wikiId,
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
      category: { not: null },
    },
    select: { category: true },
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const parts = row.category?.split("/").filter(Boolean) ?? [];
    for (let i = 1; i <= parts.length; i++) {
      const slug = parts.slice(0, i).join("/");
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([slug, itemCount]) => ({ slug, label: slug.split("/").at(-1) ?? slug, itemCount }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * 기존 ingest read tool 계약은 유지하되 모델에게 반환되는 listPages/readPage만 fail-closed loader로
 * 교체한다. searchWiki/findRelated는 modelSearch의 external 경계를 사용한다.
 */
export function scopeToolsForExternalModel(
  wikiId: string,
  tools: ToolSpec[],
  scope: ExternalModelScope,
): ToolSpec[] {
  assertExternalModelScope(scope);
  return tools.map((t) => {
    if (t.decl.name === "listPages") {
      return {
        ...t,
        handler: async () => {
          const pages = await listModelPages(wikiId, scope);
          return { pages: pages.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind })) };
        },
      };
    }
    if (t.decl.name === "readPage") {
      return {
        ...t,
        handler: async (args) => {
          const page = await getModelPage(wikiId, String(args.slug ?? ""), scope);
          if (!page) return { found: false };
          return { found: true, title: page.title, kind: page.kind, body: page.body };
        },
      };
    }
    if (t.decl.name === "findRelated") {
      return {
        ...t,
        handler: async (args) => {
          const result = await t.handler(args);
          if (!Array.isArray(result.pages)) return result;
          const slugs = result.pages
            .map((p) => (p && typeof p === "object" ? String((p as { slug?: unknown }).slug ?? "") : ""))
            .filter(Boolean);
          const allowed = await modelPolicyClient(wikiId).page.findMany({
            where: {
              wikiId,
              slug: { in: slugs },
              archivedAt: null,
              modelAccess: "external",
              kind: { not: "personal" },
            },
            select: { slug: true },
          });
          const allowedSlugs = new Set(allowed.map((p) => p.slug));
          return {
            ...result,
            pages: result.pages.filter(
              (p) => p && typeof p === "object" && allowedSlugs.has(String((p as { slug?: unknown }).slug ?? "")),
            ),
          };
        },
      };
    }
    if (t.decl.name === "getOntology") {
      return {
        ...t,
        handler: async () => ({
          categories: (await listExternalModelCategories(wikiId, scope)).map((category) => ({
            slug: category.slug,
            label: category.label,
          })),
        }),
      };
    }
    if (t.decl.name === "matchCategory") {
      return {
        ...t,
        handler: async (args) => ({
          candidates: (await listExternalModelCategories(wikiId, scope))
            .map((category) => ({
              slug: category.slug,
              label: category.label,
              score: safeCategoryScore(String(args.text ?? ""), category.slug),
            }))
            .filter((category) => category.score >= 0.5)
            .sort((a, b) => b.score - a.score)
            .slice(0, 6),
        }),
      };
    }
    return t;
  });
}
