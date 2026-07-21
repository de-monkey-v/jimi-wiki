import "server-only";
import { createHash } from "node:crypto";
import { embedTexts, embeddingEnabled, EMBED_DIM } from "@/lib/embedding";
import { ONTOLOGY_SLUG } from "@/lib/ontology";
import {
  EXTERNAL_MODEL_SCOPE,
  assertExternalModelScope,
  modelPolicyClient,
  normalizeModelAccess,
  withExternalModelDispatchLock,
  type ExternalModelScope,
  type ModelAccessValue,
} from "@/lib/model-access";
import type { PageKind, Prisma } from "@/generated/prisma/client";

export const MAX_CHUNK = 4000;
export const MIN_CHUNK = 200;
export const RRF_K = 60;
export const POOL = 50;
export const RESULT_N = 20;

// 'category'는 온톨로지 재사용 매칭용 별도 코퍼스(일반 검색에는 노출 안 됨).
export type RefType = "page" | "source" | "category";
export interface Chunk {
  heading: string;
  text: string;
  hash: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---------- 청킹 (wikisearch.mjs 포팅) ----------
export function chunkText(label: string, raw: string): Chunk[] {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, ""); // frontmatter 제거
  const lines = body.split("\n");
  const sections: { heading: string; text: string }[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.*)/);
    if (m) {
      flush();
      heading = m[1].trim();
    } else buf.push(line);
  }
  flush();

  const parts: { heading: string; text: string }[] = [];
  for (const s of sections) {
    if (s.text.length <= MAX_CHUNK) {
      parts.push(s);
      continue;
    }
    let piece = "";
    for (const para of s.text.split(/\n\n+/)) {
      if (piece && piece.length + para.length > MAX_CHUNK) {
        parts.push({ heading: s.heading, text: piece });
        piece = "";
      }
      piece = piece ? piece + "\n\n" + para : para;
    }
    if (piece) parts.push({ heading: s.heading, text: piece });
  }

  const merged: { heading: string; text: string }[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev && p.text.length < MIN_CHUNK && prev.text.length + p.text.length < MAX_CHUNK) {
      prev.text += "\n\n" + (p.heading ? `## ${p.heading}\n` : "") + p.text;
    } else merged.push({ ...p });
  }

  return merged.map((p) => {
    const ctx = p.heading ? `${label} > ${p.heading}` : label;
    const text = `[${ctx}]\n${p.text}`;
    return { heading: p.heading, text, hash: sha(text) };
  });
}

// ---------- 콘텐츠 코어 인덱싱 (FTS 전용, AI 무관) ----------
// 불변식: 저장 훅은 항상 FTS 청크만 갱신한다. 임베딩(AI)은 reindexEmbeddings 단일 경로에서만.
async function indexChunksOnly(
  tx: Prisma.TransactionClient,
  wikiId: string,
  refType: RefType,
  refId: string,
  label: string,
  body: string,
  modelAccess: ModelAccessValue,
): Promise<{ chunks: number }> {
  const chunks = chunkText(label, body);

  const existing = await tx.searchChunk.findMany({
    where: { wikiId, refType, refId },
    select: { hash: true },
  });
  const oldSet = new Set(existing.map((r) => r.hash));
  const newSet = new Set(chunks.map((c) => c.hash));
  const hashesSame = oldSet.size === newSet.size && [...newSet].every((h) => oldSet.has(h));

  // 내용 무변경이어도 정책은 동기화한다. internalOnly로 내려간 기존 벡터는 즉시 제거한다.
  if (hashesSame && chunks.length > 0) {
    if (modelAccess === "internalOnly") {
      // CHECK(modelAccess != internalOnly OR embedding IS NULL)를 한 순간도 깨지 않게
      // vector를 먼저 지운 뒤 같은 policy-lock transaction에서 projection을 내린다.
      await tx.$executeRawUnsafe(
        `UPDATE "SearchChunk" SET embedding = NULL WHERE "wikiId"=$1 AND "refType"=$2 AND "refId"=$3`,
        wikiId,
        refType,
        refId,
      );
    }
    await tx.searchChunk.updateMany({
      where: { wikiId, refType, refId },
      data: { modelAccess },
    });
    return { chunks: chunks.length };
  }

  await tx.searchChunk.deleteMany({ where: { wikiId, refType, refId } });
  if (chunks.length) {
    await tx.searchChunk.createMany({
      data: chunks.map((c) => ({
        wikiId,
        refType,
        refId,
        heading: c.heading,
        text: c.text,
        hash: c.hash,
        modelAccess,
      })),
    });
  }
  // 새 청크는 embedding NULL로 남고 reindexEmbeddings가 backfill한다.
  return { chunks: chunks.length };
}

// 단일 색인 chokepoint. personal/internalOnly도 로컬 FTS를 위해 청크는 만들되 embedding은 항상 NULL이다.
export async function reindexPage(
  wikiId: string,
  page: {
    id: string;
    slug: string;
    body: string;
    kind: PageKind;
    modelAccess?: ModelAccessValue;
    archivedAt?: Date | null;
  },
): Promise<{ chunks: number }> {
  return withExternalModelDispatchLock(wikiId, async (tx) => {
    // 호출자가 가진 stale projection/누락된 modelAccess를 신뢰하지 않고 현재 DB 상태를 색인한다.
    const current = await tx.page.findFirst({
      where: { id: page.id, wikiId },
      select: { id: true, slug: true, body: true, kind: true, modelAccess: true, archivedAt: true },
    });
    if (!current || current.archivedAt || current.slug === ONTOLOGY_SLUG) {
      await tx.searchChunk.deleteMany({ where: { wikiId, refType: "page", refId: page.id } });
      return { chunks: 0 };
    }
    const modelAccess = normalizeModelAccess(current.kind, current.modelAccess);
    return indexChunksOnly(tx, wikiId, "page", current.id, current.slug, current.body, modelAccess);
  });
}
export async function reindexSource(
  wikiId: string,
  src: {
    id: string;
    slug: string;
    body: string;
    modelAccess?: ModelAccessValue;
    archivedAt?: Date | null;
  },
) {
  return withExternalModelDispatchLock(wikiId, async (tx) => {
    const current = await tx.source.findFirst({
      where: { id: src.id, wikiId },
      select: { id: true, slug: true, body: true, modelAccess: true, archivedAt: true },
    });
    if (!current || current.archivedAt) {
      await tx.searchChunk.deleteMany({ where: { wikiId, refType: "source", refId: src.id } });
      return { chunks: 0 };
    }
    return indexChunksOnly(
      tx,
      wikiId,
      "source",
      current.id,
      current.slug,
      current.body ?? "",
      current.modelAccess,
    );
  });
}

// ---------- P2: 온톨로지 category 재사용 코퍼스 (refType='category') ----------
const catRef = (slug: string) => `category:${slug}`;
const isP2002 = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * category 1건을 임베딩 코퍼스에 반영(재사용 매칭용). 변화 없으면 no-op.
 * `@@unique(wikiId, refId) WHERE refType='category'`(부분 유니크)로 중복 행을 막고,
 * 임베딩 UPDATE는 refId가 아니라 **행 id** 기준(동시 ingest 시 벡터/텍스트 불일치 방지).
 */
export async function categoryEligibleForExternalModel(wikiId: string, slug: string): Promise<boolean> {
  const n = await modelPolicyClient(wikiId).page.count({
    where: {
      wikiId,
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
      OR: [{ category: slug }, { category: { startsWith: `${slug}/` } }],
    },
  });
  return n > 0;
}

export async function indexCategory(wikiId: string, slug: string, _text: string): Promise<void> {
  void _text;
  const db = modelPolicyClient(wikiId);
  const refId = catRef(slug);
  // internalOnly 문서에서만 생긴 category 라벨/slug도 민감할 수 있다. active external 사용처가
  // 확인되지 않으면 category corpus 자체를 만들지 않는다(문자열 match는 ontology에서 계속 가능).
  if (!(await categoryEligibleForExternalModel(wikiId, slug))) {
    await db.searchChunk.deleteMany({ where: { wikiId, refType: "category", refId } });
    return;
  }
  // ontology label/synonym에는 internalOnly 문서에서 유래한 문자열이 섞일 수 있다. category
  // corpus와 Gemini payload는 external Page에서 확인 가능한 경로 slug만으로 재생성한다.
  const text = slug;
  const hash = sha(text);
  const existing = await db.searchChunk.findFirst({
    where: { wikiId, refType: "category", refId },
    select: { id: true, hash: true },
  });
  let id: string;
  if (existing) {
    if (existing.hash === hash) {
      await db.searchChunk.update({ where: { id: existing.id }, data: { modelAccess: "external" } });
      return; // 변화 없음
    }
    await db.searchChunk.update({ where: { id: existing.id }, data: { text, hash, modelAccess: "external" } });
    id = existing.id;
  } else {
    try {
      const created = await db.searchChunk.create({
        data: { wikiId, refType: "category", refId, heading: "", text, hash, modelAccess: "external" },
        select: { id: true },
      });
      id = created.id;
    } catch (e) {
      if (!isP2002(e)) throw e; // 동시 생성 경합 → 기존 행 update로 폴백
      const row = await db.searchChunk.findFirst({ where: { wikiId, refType: "category", refId }, select: { id: true } });
      if (!row) return;
      await db.searchChunk.update({ where: { id: row.id }, data: { text, hash, modelAccess: "external" } });
      id = row.id;
    }
  }
  if (embeddingEnabled()) {
    try {
      await withExternalModelDispatchLock(wikiId, async (tx) => {
        const eligible = await tx.page.count({
          where: {
            wikiId,
            archivedAt: null,
            modelAccess: "external",
            kind: { not: "personal" },
            OR: [{ category: slug }, { category: { startsWith: `${slug}/` } }],
          },
        });
        if (eligible === 0) {
          await tx.searchChunk.deleteMany({ where: { id } });
          return;
        }
        const [vec] = await embedTexts([text], "RETRIEVAL_DOCUMENT", { wikiId, route: "ingest" });
        if (vec?.length === EMBED_DIM) {
          await tx.$executeRawUnsafe(
            `UPDATE "SearchChunk" SET embedding = $1::vector WHERE id = $2 AND "modelAccess"='external'`,
            `[${vec.join(",")}]`,
            id,
          );
        }
      });
    } catch (e) {
      console.error(`[search] category 임베딩 실패(backfill 예정): ${(e as Error).message}`);
    }
  } else {
    // 텍스트가 바뀌었는데 임베딩 못 하면 stale 벡터 제거(reindexEmbeddings가 backfill)
    await db.$executeRawUnsafe(`UPDATE "SearchChunk" SET embedding = NULL WHERE id = $1`, id).catch(() => {});
  }
}

/** rename/retire 시 category 코퍼스 행 삭제(합성 refId라 cascade 없음). */
export async function deleteCategoryChunk(wikiId: string, slug: string): Promise<void> {
  await modelPolicyClient(wikiId).searchChunk.deleteMany({ where: { wikiId, refType: "category", refId: catRef(slug) } });
}

/** 코퍼스 내 category 쌍 중 코사인 유사도가 높은(중복 의심) 쌍. lint의 병합 후보 탐지용. */
export async function findSimilarCategories(wikiId: string, minSim = 0.8): Promise<{ a: string; b: string; sim: number }[]> {
  const rows = await modelPolicyClient(wikiId).$queryRawUnsafe<{ a: string; b: string; sim: number }[]>(
    `SELECT a."refId" AS a, b."refId" AS b, 1 - (a.embedding <=> b.embedding) AS sim
     FROM "SearchChunk" a
     JOIN "SearchChunk" b
       ON b."wikiId" = a."wikiId" AND b."refType" = 'category' AND b."modelAccess"='external'
       AND b.embedding IS NOT NULL AND a."refId" < b."refId"
     WHERE a."wikiId" = $1 AND a."refType" = 'category' AND a."modelAccess"='external' AND a.embedding IS NOT NULL
       AND 1 - (a.embedding <=> b.embedding) >= $2
     ORDER BY sim DESC LIMIT 20`,
    wikiId,
    minSim,
  );
  return rows.map((r) => ({ a: r.a.replace(/^category:/, ""), b: r.b.replace(/^category:/, ""), sim: Number(r.sim) }));
}

/** 텍스트에 시맨틱하게 가까운 기존 category(재사용 후보). 키 없으면 [](G1). auto-merge 아님 — 후보만. */
export async function matchCategorySemantic(wikiId: string, text: string): Promise<{ slug: string; score: number }[]> {
  const q = text.trim();
  if (!q || !embeddingEnabled()) return [];
  try {
    return await withExternalModelDispatchLock(wikiId, async (tx) => {
      // governance가 internalOnly 페이지 제목을 그대로 넘기는 경로도 fail-closed. 정책 검사와
      // query embedding dispatch를 같은 shared lock에 둬 downgrade 경합도 막는다.
      const sensitiveTitle = await tx.page.count({
        where: { wikiId, archivedAt: null, modelAccess: "internalOnly", title: q },
      });
      if (sensitiveTitle > 0) return [];
      const [qv] = await embedTexts([q], "RETRIEVAL_QUERY", { wikiId, route: "category-match" });
      if (!qv || qv.length !== EMBED_DIM) return [];
      // S2: wikiId + refType='category' 필터(테넌트 격리 + 오염 방지)
      const rows = await tx.$queryRawUnsafe<{ refId: string; score: number }[]>(
        `SELECT "refId", 1 - (embedding <=> $2::vector) AS score FROM "SearchChunk"
         WHERE "wikiId"=$1 AND "refType"='category' AND "modelAccess"='external' AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector ASC LIMIT 8`,
        wikiId,
        `[${qv.join(",")}]`,
      );
      // 유사도 하한: 무관한 도메인 category가 재사용 후보로 주입되는 것 방지.
      const ranked = rows
        .map((row) => ({ slug: row.refId.replace(/^category:/, ""), score: Number(row.score) }))
        .filter((row) => row.score >= 0.62);
      const out: typeof ranked = [];
      for (const row of ranked) {
        const eligible = await tx.page.count({
          where: {
            wikiId,
            archivedAt: null,
            modelAccess: "external",
            kind: { not: "personal" },
            OR: [{ category: row.slug }, { category: { startsWith: `${row.slug}/` } }],
          },
        });
        if (eligible > 0) out.push(row);
      }
      return out;
    });
  } catch {
    return [];
  }
}

/**
 * 선택적 AI 레이어: embedding IS NULL 청크를 backfill한다.
 * /reindex 라우트·ingest 후처리·수동 "시맨틱 재색인"에서 호출. 비치명적(호출부에서 .catch).
 */
const REINDEX_BATCH = 500; // 호출당 처리 상한(대량 시 타임아웃 방지, remaining>0이면 재호출로 이어감)

const EMBEDDABLE_EXTERNAL_SQL = `
  c."modelAccess"='external'
  AND (
    (c."refType"='page' AND EXISTS (
      SELECT 1 FROM "Page" p
      WHERE p.id=c."refId" AND p."wikiId"=c."wikiId"
        AND p."archivedAt" IS NULL AND p."modelAccess"='external' AND p.kind <> 'personal'
    ))
    OR (c."refType"='source' AND EXISTS (
      SELECT 1 FROM "Source" s
      WHERE s.id=c."refId" AND s."wikiId"=c."wikiId"
        AND s."archivedAt" IS NULL AND s."modelAccess"='external'
    ))
    OR (c."refType"='category' AND EXISTS (
      SELECT 1 FROM "Page" p
      WHERE p."wikiId"=c."wikiId" AND p."archivedAt" IS NULL
        AND p."modelAccess"='external' AND p.kind <> 'personal'
        AND (
          p.category=substring(c."refId" from 10)
          OR left(p.category, length(substring(c."refId" from 10))+1)=substring(c."refId" from 10) || '/'
        )
    ))
  )`;

export async function reindexEmbeddings(wikiId: string): Promise<{ embedded: number; remaining: number }> {
  if (!embeddingEnabled()) return { embedded: 0, remaining: 0 };
  return withExternalModelDispatchLock(wikiId, async (tx) => {
    // SearchChunk 복제 정책만 믿지 않고 Page/Source projection을 dispatch 직전에 재검증한다.
    const rows = await tx.$queryRawUnsafe<{ id: string; text: string }[]>(
      `SELECT c.id, c.text FROM "SearchChunk" c
       WHERE c."wikiId"=$1 AND c.embedding IS NULL AND ${EMBEDDABLE_EXTERNAL_SQL}
       LIMIT ${REINDEX_BATCH}`,
      wikiId,
    );
    if (rows.length === 0) return { embedded: 0, remaining: 0 };

    const vecs = await embedTexts(
      rows.map((r) => r.text),
      "RETRIEVAL_DOCUMENT",
      { wikiId, route: "reindex" },
    );
    let embedded = 0;
    for (let i = 0; i < rows.length; i++) {
      const lit = `[${vecs[i].join(",")}]`;
      embedded += await tx.$executeRawUnsafe(
        `UPDATE "SearchChunk" c SET embedding = $1::vector
         WHERE c.id=$2 AND ${EMBEDDABLE_EXTERNAL_SQL}`,
        lit,
        rows[i].id,
      );
    }
    const rest = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "SearchChunk" c
       WHERE c."wikiId"=$1 AND c.embedding IS NULL AND ${EMBEDDABLE_EXTERNAL_SQL}`,
      wikiId,
    );
    return { embedded, remaining: Number(rest[0]?.n ?? 0) };
  });
}

// ---------- 하이브리드 검색 ----------
export interface SearchHit {
  id: string;
  refType: RefType;
  refId: string;
  heading: string;
  snippet: string;
  score: number;
  similarity?: number; // 원시 코사인 유사도(벡터 경로에서만). 관련도 게이팅용. FTS 단독 히트는 undefined.
  pageSlug?: string;
  pageTitle?: string;
}

// category 코퍼스가 일반 검색에 오염되지 않게 refType을 page/source로 제한.
// 로컬 FTS는 정책을 가리지 않으며 외부 API를 전혀 호출하지 않는다.
const LOCAL_FTS_SQL = `
  SELECT id FROM "SearchChunk"
  WHERE "wikiId" = $1
    AND "refType" IN ('page','source')
    AND to_tsvector('simple', text) @@ websearch_to_tsquery('simple', $2)
  ORDER BY ts_rank(to_tsvector('simple', text), websearch_to_tsquery('simple', $2)) DESC
  LIMIT $3`;

const MODEL_FTS_SQL = `
  SELECT id FROM "SearchChunk"
  WHERE "wikiId" = $1
    AND "refType" IN ('page','source')
    AND "modelAccess" = 'external'
    AND to_tsvector('simple', text) @@ websearch_to_tsquery('simple', $2)
  ORDER BY ts_rank(to_tsvector('simple', text), websearch_to_tsquery('simple', $2)) DESC
  LIMIT $3`;

const MODEL_VEC_SQL = `
  SELECT id, 1 - (embedding <=> $2::vector) AS sim FROM "SearchChunk"
  WHERE "wikiId" = $1
    AND "refType" IN ('page','source')
    AND "modelAccess" = 'external'
    AND embedding IS NOT NULL
  ORDER BY embedding <=> $2::vector ASC
  LIMIT $3`;

type IdRow = { id: string };
type VecRow = { id: string; sim: number };

async function hydrateActiveHits(
  tx: Prisma.TransactionClient,
  wikiId: string,
  candidates: [string, number][],
  simById: Map<string, number>,
  k: number,
  access: "local" | "external",
): Promise<SearchHit[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map(([id]) => id);
  const chunks = await tx.searchChunk.findMany({
    where: { id: { in: ids } },
    select: { id: true, refType: true, refId: true, heading: true, text: true, modelAccess: true },
  });
  const byId = new Map(chunks.map((c) => [c.id, c]));

  const pageIds = chunks.filter((c) => c.refType === "page").map((c) => c.refId);
  const sourceIds = chunks.filter((c) => c.refType === "source").map((c) => c.refId);
  const pages = pageIds.length
    ? await tx.page.findMany({
        where: {
          wikiId,
          id: { in: pageIds },
          archivedAt: null,
          ...(access === "external"
            ? {
                modelAccess: "external" as const,
                kind: { not: "personal" as const },
                slug: { not: ONTOLOGY_SLUG },
              }
            : {}),
        },
        select: { id: true, slug: true, title: true },
      })
    : [];
  const sources = sourceIds.length
    ? await tx.source.findMany({
        where: {
          wikiId,
          id: { in: sourceIds },
          archivedAt: null,
          ...(access === "external" ? { modelAccess: "external" as const } : {}),
        },
        select: { id: true },
      })
    : [];
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const sourceSet = new Set(sources.map((s) => s.id));

  const seenRefs = new Set<string>();
  const hits: SearchHit[] = [];
  for (const [id, score] of candidates) {
    if (hits.length >= k) break;
    const c = byId.get(id);
    if (!c) continue;
    if (access === "external" && c.modelAccess !== "external") continue;
    const pg = c.refType === "page" ? pageById.get(c.refId) : undefined;
    if (c.refType === "page" && !pg) continue;
    if (c.refType === "source" && !sourceSet.has(c.refId)) continue;
    if (c.refType !== "page" && c.refType !== "source") continue;
    const refKey = `${c.refType}:${c.refId}`;
    if (seenRefs.has(refKey)) continue; // 같은 페이지/소스의 다른 청크 중복 제거
    seenRefs.add(refKey);
    const snippet = c.text.replace(/^\[.*?\]\n/, "").replace(/\s+/g, " ").slice(0, 180);
    hits.push({
      id,
      refType: c.refType as RefType,
      refId: c.refId,
      heading: c.heading,
      snippet,
      score,
      similarity: simById.get(id),
      pageSlug: pg?.slug,
      pageTitle: pg?.title,
    });
  }
  return hits;
}

/** 인증된 UI 전용 로컬 검색. Gemini query embedding을 포함해 외부 호출을 전혀 하지 않는다. */
export async function localFtsSearch(wikiId: string, queryText: string, k = RESULT_N): Promise<SearchHit[]> {
  const q = queryText.trim();
  if (!q) return [];
  const rows = await modelPolicyClient(wikiId).$queryRawUnsafe<IdRow[]>(LOCAL_FTS_SQL, wikiId, q, Math.max(POOL, k * 3));
  const candidates: [string, number][] = rows
    .slice(0, k * 3)
    .map((r, i) => [r.id, 1 / (RRF_K + i + 1)]);
  return hydrateActiveHits(modelPolicyClient(wikiId), wikiId, candidates, new Map(), k, "local");
}

export interface ModelSearchOptions extends ExternalModelScope {
  wikiId: string;
  queryText: string;
  k?: number;
}

/** 외부 모델용 검색. external active projection만 반환하고 query embedding도 이 경로에서만 수행한다. */
export async function modelSearch(opts: ModelSearchOptions): Promise<SearchHit[]> {
  assertExternalModelScope(opts);
  const { wikiId } = opts;
  const k = opts.k ?? RESULT_N;
  const q = opts.queryText.trim();
  if (!q) return [];

  return withExternalModelDispatchLock(wikiId, async (tx) => {
    const ftsRows = await tx.$queryRawUnsafe<IdRow[]>(MODEL_FTS_SQL, wikiId, q, POOL);
    let vecRows: VecRow[] = [];
    if (embeddingEnabled()) {
      try {
        const [qv] = await embedTexts([q], "RETRIEVAL_QUERY", { wikiId, route: "search" });
        if (qv?.length === EMBED_DIM) {
          vecRows = await tx.$queryRawUnsafe<VecRow[]>(MODEL_VEC_SQL, wikiId, `[${qv.join(",")}]`, POOL);
        }
      } catch (e) {
        console.error(`[search] 쿼리 임베딩 실패, FTS 단독 폴백: ${(e as Error).message}`);
      }
    }

    const simById = new Map(vecRows.map((r) => [r.id, Number(r.sim)]));
    const scores = new Map<string, number>();
    const add = (rows: IdRow[]) =>
      rows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
    add(ftsRows);
    add(vecRows);
    const candidates = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k * 3);
    return hydrateActiveHits(tx, wikiId, candidates, simById, k, "external");
  });
}

/** 기존 호출자 호환. 무스코프 이름이지만 동작은 항상 external-only로 축소한다. */
export function hybridSearch(wikiId: string, queryText: string, k = RESULT_N): Promise<SearchHit[]> {
  return modelSearch({ ...EXTERNAL_MODEL_SCOPE, wikiId, queryText, k });
}

// ---------- KG(지식 그래프) 검색 확장 ----------
// hybridSearch 로 얻은 seed 페이지에서 타입드 관계(ConceptRelation) 그래프를 따라 이웃 개념을 끌어와
// 답변 컨텍스트를 넓힌다(GraphRAG). hybridSearch/RRF/dedup 은 건드리지 않는다 — 이건 순수 후처리다.
//
// 튜닝 노브는 env-only(쿼리시각 파라미터, 스키마/인덱스 결합 없음). KG_MAX_HOP=0 = 킬스위치.
// 기존 `||` 관용구는 '0'/빈문자열/NaN 을 오처리하므로 NaN 가드 헬퍼로 읽는다.
const envInt = (s: string | undefined, d: number): number => {
  const t = s?.trim(); // 공백-only 값이 Number("  ")=0 으로 킬스위치 오작동하는 것 방지
  const n = Number(t);
  return t && Number.isFinite(n) ? Math.trunc(n) : d;
};
const envFloat = (s: string | undefined, d: number): number => {
  const t = s?.trim();
  const n = Number(t);
  return t && Number.isFinite(n) ? n : d;
};

export interface KgConfig {
  maxHop: number;
  simCutoff: number;
  hubCap: number;
  nodeBudget: number;
}
// 운영자가 env로 과도한 홉을 줘도 순회 폭발(hubCap^hop)을 막는 코드 상한.
const KG_HOP_HARD_MAX = 4;
export function kgConfig(): KgConfig {
  return {
    maxHop: Math.min(KG_HOP_HARD_MAX, Math.max(0, envInt(process.env.KG_MAX_HOP, 2))),
    simCutoff: envFloat(process.env.KG_SIM_CUTOFF, 0.55),
    hubCap: Math.max(1, envInt(process.env.KG_HUB_CAP, 25)),
    nodeBudget: Math.max(1, envInt(process.env.KG_NODE_BUDGET, 12)),
  };
}

// 다국어 관계 cue. 사실 조회("X란?")가 아니라 관계·비교·인과를 묻는 질의를 감지.
// '왜/어떻게/why/how'는 일반 질문에도 흔해 false positive가 커서 넣지 않는다(확장 과잉발동 방지).
// CJK cue는 부분문자열 매치(자연스러움). ASCII cue는 반드시 \b 단어경계 — 없으면 "be`cause`",
// "in`depend`ent", "T`Vs`", "`differ`ent" 같은 흔한 단어에 오발동해 확장이 과발동한다.
const RELATIONAL_CUE_CJK = /관계|관련|연관|비교|차이|다른\s*점|영향|원인|의존|関係|違い|比較|原因|影響|关系|区别|比较|原因|影响/;
const RELATIONAL_CUE_ASCII =
  /\b(?:vs|versus|compares?|comparison|differ(?:ent|ence|s)?|between|relationship|related to|depends?|causes?|affects?|impacts?)\b/i;
export function isRelationalQuery(q: string): boolean {
  return RELATIONAL_CUE_CJK.test(q) || RELATIONAL_CUE_ASCII.test(q);
}

export interface DepthSignal {
  seedCount: number;
  topSimilarity?: number; // 벡터히트 최대 코사인. FTS-only/임베딩 off면 undefined
  isRelational: boolean;
}
/**
 * 질의별 KG 확장 홉수. 강한 직접매치 + 비관계 질의는 0(확장 안 함 → hybridSearch 결과와 동일).
 * undefined 유사도(FTS-only/임베딩 off)를 'weak'로 치지 않는다 — 벡터신호 부재를 약한 관련도로
 * 오판하면 대부분 질의에서 확장이 과발동한다. 그 경우엔 isRelational 만으로 확장한다.
 * (진짜 no-op 보장은 빈 KG: expandViaGraph 가 [] 반환. 이 함수의 0 반환은 부가 보장.)
 */
export function plannedDepth(sig: DepthSignal, cfg: KgConfig = kgConfig()): number {
  if (cfg.maxHop <= 0) return 0; // 킬스위치
  if (sig.seedCount === 0) return 0; // 확장할 씨앗 없음
  const weak = sig.topSimilarity !== undefined && sig.topSimilarity < cfg.simCutoff;
  let d = 0;
  if (weak) d += 1;
  if (sig.isRelational) d += 1;
  return Math.min(d, cfg.maxHop);
}

const GRAPH_TRUTHY = new Set(["1", "true", "yes"]);

/**
 * 외부 호출자(REST/MCP)가 명시한 KG 확장 홉수. graph 파라미터가 없으면 0(확장 없음).
 * depth 생략 시 1홉이며 상한은 cfg.maxHop — KG_MAX_HOP=0 킬스위치면 0이 되어 확장이 꺼진다.
 * plannedDepth 의 질의 휴리스틱은 쓰지 않는다: 외부 에이전트에는 결정적 동작이 낫고,
 * 확장 여부 판단은 호출자(에이전트)가 스스로 한다.
 */
export function requestedGraphDepth(
  params: { graph?: string | null; depth?: string | null },
  cfg: KgConfig = kgConfig(),
): number {
  if (!GRAPH_TRUTHY.has((params.graph ?? "").toLowerCase())) return 0;
  const raw = parseInt(params.depth ?? "", 10);
  const requested = Number.isFinite(raw) ? Math.max(raw, 1) : 1;
  return Math.min(requested, Math.max(cfg.maxHop, 0));
}

export interface GraphNeighbor {
  pageId: string;
  slug: string;
  title: string;
  snippet: string;
  depth: number; // seed 로부터의 최단 홉수(1..maxHop)
}
const KG_SNIPPET_CHARS = 400; // 이웃 본문 발췌 상한(seed 스니펫과 균형, LLM 컨텍스트 bloat 방지)
// cuid(소문자+숫자)만 통과 → 검증된 값만 text[] 리터럴에 넣어 인젝션 여지를 없앤다.
const isCuidLike = (s: string) => /^[a-z0-9]+$/.test(s);

// 무향 도달성(개념 연관은 대체로 무향), path[]로 사이클 안전, depth 상한($3), 허브 fan-out 상한($4),
// node budget 하드캡($5), 모든 엣지 스캔에 wikiId=$1(테넌트 격리). 차수는 비재귀 CTE(deg)로 precompute —
// 재귀 항에 집계 서브쿼리를 넣으면 pg가 거부하므로 LEFT JOIN 으로 게이팅한다. 허브캡은 seed(depth=0) 제외.
const EXPAND_SQL = `
WITH RECURSIVE
external_rel AS (
  SELECT r."fromPageId", r."toPageId"
  FROM "ConceptRelation" r
  JOIN "Source" s ON s.id=r."sourceId" AND s."wikiId"=r."wikiId"
  JOIN "Page" pf ON pf.id=r."fromPageId" AND pf."wikiId"=r."wikiId"
  JOIN "Page" pt ON pt.id=r."toPageId" AND pt."wikiId"=r."wikiId"
  WHERE r."wikiId"=$1 AND s."archivedAt" IS NULL AND s."modelAccess"='external'
    AND pf."archivedAt" IS NULL AND pf."modelAccess"='external' AND pf.kind <> 'personal'
    AND pt."archivedAt" IS NULL AND pt."modelAccess"='external' AND pt.kind <> 'personal'
),
deg AS (
  -- 위상적 차수 = 서로 다른 이웃 개념 수. count(*)로 엣지 행을 세면 같은 논리 엣지가
  -- 원문마다 1행(unique 키에 sourceId 포함)이라, 다중근거 개념이 허브로 오판돼 확장이 막힌다.
  SELECT pid, count(DISTINCT nbr)::int AS c FROM (
    SELECT "fromPageId" AS pid, "toPageId" AS nbr FROM external_rel
    UNION ALL
    SELECT "toPageId" AS pid, "fromPageId" AS nbr FROM external_rel
  ) u GROUP BY pid
),
uedges AS (
  SELECT "fromPageId" AS src, "toPageId" AS dst FROM external_rel
  UNION ALL
  SELECT "toPageId" AS src, "fromPageId" AS dst FROM external_rel
),
seed(page_id) AS ( SELECT unnest($2::text[]) ),
walk(page_id, depth, path) AS (
  SELECT page_id, 0, ARRAY[page_id] FROM seed
  UNION ALL
  SELECT e.dst, w.depth + 1, w.path || e.dst
  FROM walk w
  JOIN uedges e ON e.src = w.page_id
  LEFT JOIN deg d ON d.pid = w.page_id
  WHERE w.depth < $3
    AND e.dst <> ALL(w.path)
    AND (w.depth = 0 OR COALESCE(d.c, 0) <= $4)
)
SELECT page_id, min(depth)::int AS depth
FROM walk
WHERE depth > 0 AND page_id <> ALL($2::text[])
GROUP BY page_id
ORDER BY depth ASC, page_id
LIMIT $5`;

/**
 * seed 페이지들에서 ConceptRelation 그래프를 depth홉 확장해 이웃 개념 페이지를 반환한다.
 * depth<=0 또는 seed 없음 → SQL 안 돌리고 [] (hybridSearch 동작 완전 보존). CTE 실패는 삼키지 않고
 * 로깅한다(죽은 기능이 조용히 [] 반환하는 것 방지). 반환 페이지는 테넌트/온톨로지 재격리 + 본문 발췌.
 */
export async function expandViaGraph(wikiId: string, seedPageIds: string[], depth: number): Promise<GraphNeighbor[]> {
  const cfg = kgConfig();
  const seeds = [...new Set(seedPageIds.filter(isCuidLike))];
  if (depth <= 0 || seeds.length === 0) return [];
  const literal = `{${seeds.join(",")}}`; // 검증된 cuid만 → 안전한 Postgres text[] 리터럴
  let rows: { page_id: string; depth: number }[];
  try {
    rows = await modelPolicyClient(wikiId).$queryRawUnsafe<{ page_id: string; depth: number }[]>(
      EXPAND_SQL,
      wikiId,
      literal,
      Math.min(depth, cfg.maxHop),
      cfg.hubCap,
      cfg.nodeBudget,
    );
  } catch (e) {
    console.error(`[search] expandViaGraph CTE 실패: ${(e as Error).message}`);
    return [];
  }
  if (rows.length === 0) return [];
  const depthById = new Map(rows.map((r) => [r.page_id, Number(r.depth)]));
  const pages = await modelPolicyClient(wikiId).page.findMany({
    // 테넌트 재격리 + active external 정책 재검증. stale 엣지가 남아도 internal 본문은 반환하지 않는다.
    where: {
      wikiId,
      id: { in: rows.map((r) => r.page_id) },
      slug: { not: ONTOLOGY_SLUG },
      archivedAt: null,
      modelAccess: "external",
      kind: { not: "personal" },
    },
    select: { id: true, slug: true, title: true, body: true },
  });
  return pages
    .map((p) => ({
      pageId: p.id,
      slug: p.slug,
      title: p.title,
      snippet: p.body
        .replace(/^---\n[\s\S]*?\n---\n/, "") // frontmatter 제거
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, KG_SNIPPET_CHARS),
      depth: depthById.get(p.id) ?? 1,
    }))
    .sort((a, b) => a.depth - b.depth || a.slug.localeCompare(b.slug));
}
