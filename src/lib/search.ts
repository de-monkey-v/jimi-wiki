import "server-only";
import { prisma } from "@/lib/db";
import { createHash } from "node:crypto";
import { embedTexts, geminiEnabled, EMBED_DIM } from "@/lib/gemini";
import { ONTOLOGY_SLUG } from "@/lib/ontology";

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
  wikiId: string,
  refType: RefType,
  refId: string,
  label: string,
  body: string,
): Promise<{ chunks: number }> {
  const chunks = chunkText(label, body);

  const existing = await prisma.searchChunk.findMany({
    where: { wikiId, refType, refId },
    select: { hash: true },
  });
  const oldSet = new Set(existing.map((r) => r.hash));
  const newSet = new Set(chunks.map((c) => c.hash));
  const hashesSame = oldSet.size === newSet.size && [...newSet].every((h) => oldSet.has(h));

  // 내용 무변경이면 조기 반환 → 기존 임베딩 보존(재저장 시 벡터 유실 방지)
  if (hashesSame && chunks.length > 0) return { chunks: chunks.length };

  await prisma.$transaction(async (tx) => {
    await tx.searchChunk.deleteMany({ where: { wikiId, refType, refId } });
    if (chunks.length) {
      await tx.searchChunk.createMany({
        data: chunks.map((c) => ({ wikiId, refType, refId, heading: c.heading, text: c.text, hash: c.hash })),
      });
    }
  });
  // 새 청크는 embedding NULL로 남고 reindexEmbeddings가 backfill한다.
  return { chunks: chunks.length };
}

export function reindexPage(wikiId: string, page: { id: string; slug: string; body: string }) {
  if (page.slug === ONTOLOGY_SLUG) return Promise.resolve({ chunks: 0 }); // O1: 온톨로지 페이지는 검색에 색인하지 않음
  return indexChunksOnly(wikiId, "page", page.id, page.slug, page.body);
}
export function reindexSource(wikiId: string, src: { id: string; slug: string; body: string }) {
  return indexChunksOnly(wikiId, "source", src.id, src.slug, src.body);
}

// ---------- P2: 온톨로지 category 재사용 코퍼스 (refType='category') ----------
const catRef = (slug: string) => `category:${slug}`;
const isP2002 = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * category 1건을 임베딩 코퍼스에 반영(재사용 매칭용). 변화 없으면 no-op.
 * `@@unique(wikiId, refId) WHERE refType='category'`(부분 유니크)로 중복 행을 막고,
 * 임베딩 UPDATE는 refId가 아니라 **행 id** 기준(동시 ingest 시 벡터/텍스트 불일치 방지).
 */
export async function indexCategory(wikiId: string, slug: string, text: string): Promise<void> {
  const refId = catRef(slug);
  const hash = sha(text);
  const existing = await prisma.searchChunk.findFirst({
    where: { wikiId, refType: "category", refId },
    select: { id: true, hash: true },
  });
  let id: string;
  if (existing) {
    if (existing.hash === hash) return; // 변화 없음
    await prisma.searchChunk.update({ where: { id: existing.id }, data: { text, hash } });
    id = existing.id;
  } else {
    try {
      const created = await prisma.searchChunk.create({
        data: { wikiId, refType: "category", refId, heading: "", text, hash },
        select: { id: true },
      });
      id = created.id;
    } catch (e) {
      if (!isP2002(e)) throw e; // 동시 생성 경합 → 기존 행 update로 폴백
      const row = await prisma.searchChunk.findFirst({ where: { wikiId, refType: "category", refId }, select: { id: true } });
      if (!row) return;
      await prisma.searchChunk.update({ where: { id: row.id }, data: { text, hash } });
      id = row.id;
    }
  }
  if (geminiEnabled()) {
    try {
      const [vec] = await embedTexts([text], "RETRIEVAL_DOCUMENT");
      if (vec?.length === EMBED_DIM) {
        await prisma.$executeRawUnsafe(`UPDATE "SearchChunk" SET embedding = $1::vector WHERE id = $2`, `[${vec.join(",")}]`, id);
      }
    } catch (e) {
      console.error(`[search] category 임베딩 실패(backfill 예정): ${(e as Error).message}`);
    }
  } else {
    // 텍스트가 바뀌었는데 임베딩 못 하면 stale 벡터 제거(reindexEmbeddings가 backfill)
    await prisma.$executeRawUnsafe(`UPDATE "SearchChunk" SET embedding = NULL WHERE id = $1`, id).catch(() => {});
  }
}

/** rename/retire 시 category 코퍼스 행 삭제(합성 refId라 cascade 없음). */
export async function deleteCategoryChunk(wikiId: string, slug: string): Promise<void> {
  await prisma.searchChunk.deleteMany({ where: { wikiId, refType: "category", refId: catRef(slug) } });
}

/** 코퍼스 내 category 쌍 중 코사인 유사도가 높은(중복 의심) 쌍. lint의 병합 후보 탐지용. */
export async function findSimilarCategories(wikiId: string, minSim = 0.8): Promise<{ a: string; b: string; sim: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ a: string; b: string; sim: number }[]>(
    `SELECT a."refId" AS a, b."refId" AS b, 1 - (a.embedding <=> b.embedding) AS sim
     FROM "SearchChunk" a
     JOIN "SearchChunk" b
       ON b."wikiId" = a."wikiId" AND b."refType" = 'category' AND b.embedding IS NOT NULL AND a."refId" < b."refId"
     WHERE a."wikiId" = $1 AND a."refType" = 'category' AND a.embedding IS NOT NULL
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
  if (!q || !geminiEnabled()) return [];
  let qv: number[] | undefined;
  try {
    [qv] = await embedTexts([q], "RETRIEVAL_QUERY");
  } catch {
    return [];
  }
  if (!qv || qv.length !== EMBED_DIM) return [];
  // S2: wikiId + refType='category' 필터(테넌트 격리 + 오염 방지)
  const rows = await prisma.$queryRawUnsafe<{ refId: string; score: number }[]>(
    `SELECT "refId", 1 - (embedding <=> $2::vector) AS score FROM "SearchChunk"
     WHERE "wikiId"=$1 AND "refType"='category' AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector ASC LIMIT 8`,
    wikiId,
    `[${qv.join(",")}]`,
  );
  // 유사도 하한: 무관한 도메인 category가 재사용 후보로 주입되는 것 방지(문자열 경로의 0.5 floor와 대칭)
  return rows
    .map((r) => ({ slug: r.refId.replace(/^category:/, ""), score: Number(r.score) }))
    .filter((r) => r.score >= 0.62);
}

/**
 * 선택적 AI 레이어: embedding IS NULL 청크를 backfill한다.
 * /reindex 라우트·ingest 후처리·수동 "시맨틱 재색인"에서 호출. 비치명적(호출부에서 .catch).
 */
const REINDEX_BATCH = 500; // 호출당 처리 상한(대량 시 타임아웃 방지, remaining>0이면 재호출로 이어감)

export async function reindexEmbeddings(wikiId: string): Promise<{ embedded: number; remaining: number }> {
  if (!geminiEnabled()) return { embedded: 0, remaining: 0 };
  const rows = await prisma.$queryRawUnsafe<{ id: string; text: string }[]>(
    `SELECT id, text FROM "SearchChunk" WHERE "wikiId"=$1 AND embedding IS NULL LIMIT ${REINDEX_BATCH}`,
    wikiId,
  );
  if (rows.length === 0) return { embedded: 0, remaining: 0 };

  const vecs = await embedTexts(
    rows.map((r) => r.text),
    "RETRIEVAL_DOCUMENT",
  );
  for (let i = 0; i < rows.length; i++) {
    const lit = `[${vecs[i].join(",")}]`;
    await prisma.$executeRawUnsafe(`UPDATE "SearchChunk" SET embedding = $1::vector WHERE id = $2`, lit, rows[i].id);
  }
  const rest = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "SearchChunk" WHERE "wikiId"=$1 AND embedding IS NULL`,
    wikiId,
  );
  return { embedded: rows.length, remaining: Number(rest[0]?.n ?? 0) };
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

// S2: category 코퍼스가 일반 검색에 오염되지 않게 refType을 page/source로 제한.
const FTS_SQL = `
  SELECT id FROM "SearchChunk"
  WHERE "wikiId" = $1
    AND "refType" IN ('page','source')
    AND to_tsvector('simple', text) @@ websearch_to_tsquery('simple', $2)
  ORDER BY ts_rank(to_tsvector('simple', text), websearch_to_tsquery('simple', $2)) DESC
  LIMIT $3`;

const VEC_SQL = `
  SELECT id, 1 - (embedding <=> $2::vector) AS sim FROM "SearchChunk"
  WHERE "wikiId" = $1 AND "refType" IN ('page','source') AND embedding IS NOT NULL
  ORDER BY embedding <=> $2::vector ASC
  LIMIT $3`;

type IdRow = { id: string };
type VecRow = { id: string; sim: number };

export async function hybridSearch(wikiId: string, queryText: string, k = RESULT_N): Promise<SearchHit[]> {
  const q = queryText.trim();
  if (!q) return [];

  const ftsRows = await prisma.$queryRawUnsafe<IdRow[]>(FTS_SQL, wikiId, q, POOL);

  let vecRows: VecRow[] = [];
  if (geminiEnabled()) {
    try {
      const [qv] = await embedTexts([q], "RETRIEVAL_QUERY");
      if (qv?.length === EMBED_DIM) {
        vecRows = await prisma.$queryRawUnsafe<VecRow[]>(VEC_SQL, wikiId, `[${qv.join(",")}]`, POOL);
      }
    } catch (e) {
      // 쿼리 임베딩 실패 시 FTS 단독으로 graceful degrade (검색 자체는 죽지 않음)
      console.error(`[search] 쿼리 임베딩 실패, FTS 단독 폴백: ${(e as Error).message}`);
    }
  }

  // 관련도 게이팅용 원시 코사인 유사도(id → sim)
  const simById = new Map(vecRows.map((r) => [r.id, Number(r.sim)]));

  // RRF: score = Σ 1/(K + rank)
  const scores = new Map<string, number>();
  const add = (rows: IdRow[]) =>
    rows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
  add(ftsRows);
  add(vecRows);

  const rankedAll = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!rankedAll.length) return [];

  // 페이지/소스 단위 dedup을 위해 후보를 넉넉히(k*3) 확보
  const candidates = rankedAll.slice(0, k * 3);
  const ids = candidates.map(([id]) => id);
  const chunks = await prisma.searchChunk.findMany({
    where: { id: { in: ids } },
    select: { id: true, refType: true, refId: true, heading: true, text: true },
  });
  const byId = new Map(chunks.map((c) => [c.id, c]));

  const pageIds = chunks.filter((c) => c.refType === "page").map((c) => c.refId);
  const pages = pageIds.length
    ? await prisma.page.findMany({ where: { id: { in: pageIds } }, select: { id: true, slug: true, title: true } })
    : [];
  const pageById = new Map(pages.map((p) => [p.id, p]));

  const seenRefs = new Set<string>();
  const hits: SearchHit[] = [];
  for (const [id, score] of candidates) {
    if (hits.length >= k) break;
    const c = byId.get(id);
    if (!c) continue;
    const refKey = `${c.refType}:${c.refId}`;
    if (seenRefs.has(refKey)) continue; // 같은 페이지/소스의 다른 청크 중복 제거
    seenRefs.add(refKey);
    const snippet = c.text.replace(/^\[.*?\]\n/, "").replace(/\s+/g, " ").slice(0, 180);
    const pg = c.refType === "page" ? pageById.get(c.refId) : undefined;
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
