import "server-only";
import { prisma } from "@/lib/db";
import {
  ContentVersionConflictError,
  createPageSnapshot,
  updatePageSnapshot,
} from "@/lib/content-store";
import { ONTOLOGY_PAGE_SLUG, isReservedWikiPageSlug } from "@/lib/wiki-routes";

// ---------- 정본 규칙과 동기화되는 상수 (rules/ontology-rules.md 의 version:과 일치) ----------
export const ONTOLOGY_RULES_VERSION = 3;
export const PROMOTION_MIN_ITEMS = 3; // 새 category 승격 최소 항목 수
export const CATEGORY_MAX_DEPTH = 4;
export const RESERVED_RELATIONS = ["uses", "is-a", "part-of", "contradicts", "example-of", "developed-by"] as const;

// system 페이지 slug 예약(O2). 일반 writePage/upsertPage로 쓸 수 없다.
export const ONTOLOGY_SLUG = ONTOLOGY_PAGE_SLUG;
// system slug + `/wikis/[slug]/...` 정적 라우트와의 충돌을 공용 SSOT로 방지한다.
export function isReservedSlug(slug: string): boolean {
  return isReservedWikiPageSlug(slug);
}

// ---------- 온톨로지 문서 ----------
export interface OntologyCategory {
  slug: string; // 경로형: "ai/architectures"
  label: string;
  parent?: string;
  synonyms?: string[];
  itemCount?: number;
}
export interface OntologyDoc {
  version: number;
  categories: OntologyCategory[];
  relationTypes: string[];
}

const DEFAULT_ONTOLOGY: OntologyDoc = { version: 0, categories: [], relationTypes: [...RESERVED_RELATIONS] };

const isP2002 = (e: unknown) => (e as { code?: string })?.code === "P2002";

// ---------- S1: 신뢰할 수 없는 소스 유래 토큰 정화 ----------
// category slug/label 은 소스에서 파생될 수 있으므로 제약 토큰으로만 취급(프롬프트 인젝션 방지).
const SLUG_RE = /[^a-z0-9가-힣/_-]/g;
const LABEL_RE = /[^a-z0-9가-힣 ()/_-]/gi;

export function sanitizeCategorySlug(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-") // 공백 → 하이픈
    .replace(SLUG_RE, "") // 허용 외 문자 제거
    .replace(/-*\/-*/g, "/") // 슬래시 주변 하이픈 제거: "a / b" → "a-/-b" → "a/b"
    .replace(/\/{2,}/g, "/") // 연속 슬래시 축약
    .replace(/-{2,}/g, "-") // 연속 하이픈 축약
    .replace(/^[/-]+|[/-]+$/g, ""); // 앞뒤 슬래시·하이픈 제거
  if (!s) return null;
  if (s.split("/").length > CATEGORY_MAX_DEPTH) return null;
  return s.slice(0, 60);
}
export function sanitizeLabel(raw: string): string {
  return raw.trim().replace(LABEL_RE, "").slice(0, 60) || "무제";
}

// ---------- 직렬화/파싱 ----------
function serialize(doc: OntologyDoc): string {
  return (
    `# 온톨로지 (자동 관리 — 직접 편집 주의)\n\n` +
    "이 페이지는 위키의 분류 체계(카테고리·관계 어휘)를 담는 system 페이지입니다. 검색·사이드바에 노출되지 않습니다.\n\n" +
    "```json\n" +
    JSON.stringify(doc, null, 2) +
    "\n```\n"
  );
}

function parseDoc(body: string | null | undefined): OntologyDoc | null {
  if (!body) return null;
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as Partial<OntologyDoc>;
    return validate(raw);
  } catch {
    return null;
  }
}

// 방어적 검증: throw 대신 무효 항목을 버리고 정규화(에이전트/사람 편집 견딤)
function validate(raw: Partial<OntologyDoc>): OntologyDoc {
  const categories: OntologyCategory[] = [];
  for (const c of Array.isArray(raw.categories) ? raw.categories : []) {
    const slug = typeof c?.slug === "string" ? sanitizeCategorySlug(c.slug) : null;
    if (!slug) continue;
    categories.push({
      slug,
      label: sanitizeLabel(typeof c.label === "string" ? c.label : slug),
      parent: typeof c.parent === "string" ? (sanitizeCategorySlug(c.parent) ?? undefined) : undefined,
      synonyms: Array.isArray(c.synonyms) ? c.synonyms.filter((s): s is string => typeof s === "string").map(sanitizeLabel).slice(0, 12) : undefined,
      itemCount: typeof c.itemCount === "number" ? c.itemCount : undefined,
    });
  }
  const relationTypes =
    Array.isArray(raw.relationTypes) && raw.relationTypes.every((r) => typeof r === "string")
      ? (raw.relationTypes as string[])
      : [...RESERVED_RELATIONS];
  return { version: typeof raw.version === "number" ? raw.version : 0, categories, relationTypes };
}

// ---------- 읽기 ----------
/** meta:ontology 페이지를 읽어 파싱. 없거나 깨졌으면 기본 spine 반환(절대 throw 안 함). */
export async function getOntology(wikiId: string): Promise<OntologyDoc> {
  try {
    const page = await prisma.page.findFirst({
      where: { wikiId, slug: ONTOLOGY_SLUG, archivedAt: null },
      select: { body: true },
    });
    return parseDoc(page?.body) ?? { ...DEFAULT_ONTOLOGY };
  } catch {
    return { ...DEFAULT_ONTOLOGY };
  }
}

/** 실제 페이지에 쓰인 category(자유형) 목록. 온톨로지 미성숙 단계의 부트스트랩·에이전트 힌트용. */
export async function listCategories(wikiId: string): Promise<string[]> {
  const rows = await prisma.page.findMany({
    where: { wikiId, archivedAt: null, category: { not: null } },
    select: { category: true },
    distinct: ["category"],
  });
  return rows.map((r) => r.category!).filter(Boolean).sort();
}

// ---------- 쓰기 (거버넌스 경로, C1 낙관적 동시성) ----------
/**
 * 온톨로지를 mutate로 변경. version 증가 + body compare-and-swap(재시도)로
 * after() 동시 ingest의 lost-update를 방지한다. reindex 하지 않음(O1: 검색 비노출).
 */
export async function setOntology(wikiId: string, mutate: (cur: OntologyDoc) => OntologyDoc): Promise<OntologyDoc> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const page = await prisma.page.findUnique({
      where: { wikiId_slug: { wikiId, slug: ONTOLOGY_SLUG } },
      select: { id: true, body: true, currentVersion: true, archivedAt: true },
    });
    if (page?.archivedAt) throw new Error("보관된 온톨로지 페이지가 system slug를 점유하고 있습니다");
    const cur = parseDoc(page?.body) ?? { ...DEFAULT_ONTOLOGY };
    const next = validate(mutate(structuredClone(cur)));
    next.version = cur.version + 1;
    const body = serialize(next);

    if (!page) {
      try {
        await createPageSnapshot({
          wikiId,
          slug: ONTOLOGY_SLUG,
          title: "온톨로지",
          kind: "meta",
          body,
          context: { actor: "system", reason: `ontology v${next.version}` },
        });
      } catch (e) {
        if (isP2002(e)) continue; // 경합 생성 → 재시도(update 경로로)
        throw e;
      }
    } else {
      try {
        await updatePageSnapshot({
          wikiId,
          pageId: page.id,
          expectedVersion: page.currentVersion,
          changes: { body },
          context: { actor: "system", reason: `ontology v${next.version}` },
        });
      } catch (e) {
        if (e instanceof ContentVersionConflictError) continue; // 그 사이 누가 바꿈 → 재시도
        throw e;
      }
    }

    await prisma.logEntry.create({
      data: { wikiId, kind: "ontology", title: `ontology v${next.version}`, detail: `categories=${next.categories.length}` },
    });
    return next;
  }
  throw new Error("온톨로지 동시 갱신 충돌(재시도 초과)");
}

// ---------- 재사용-우선 매칭 (P1: 문자열/alias; 임베딩은 P2) ----------
function normMatch(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_/-]+/g, " ").replace(/[^a-z0-9가-힣 ]/g, "").trim();
}
function sim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter); // Jaccard
}

/**
 * ingest 후: 온톨로지 문서를 실제 페이지의 category 집합과 **양방향** 동기화.
 * 신규 category 추가 + 더 이상 쓰이지 않는 category 제거(단조증가/고아 방지). 제거된 slug 목록을 반환(코퍼스 청크 삭제용).
 */
export async function syncOntologyWithPages(wikiId: string): Promise<{ added: string[]; removed: string[] }> {
  const [used, onto] = await Promise.all([listCategories(wikiId), getOntology(wikiId)]);
  const live = new Set(used.map((c) => sanitizeCategorySlug(c)).filter((s): s is string => !!s));
  const have = new Set(onto.categories.map((c) => c.slug));
  const added = [...live].filter((s) => !have.has(s));
  const removed = [...have].filter((s) => !live.has(s));
  if (added.length === 0 && removed.length === 0) return { added: [], removed: [] };
  await setOntology(wikiId, (cur) => {
    cur.categories = cur.categories.filter((c) => live.has(c.slug)); // 고아 제거
    const h = new Set(cur.categories.map((c) => c.slug));
    for (const s of added) {
      if (h.has(s)) continue;
      cur.categories.push({ slug: s, label: s.split("/").pop() ?? s, itemCount: 0 });
      h.add(s);
    }
    return cur;
  });
  return { added, removed };
}

export interface CategoryMatch {
  slug: string;
  label: string;
  score: number;
}
/** 후보 텍스트에 가장 가까운 기존 category(재사용 우선). P1은 문자열/alias 기반. */
export async function matchCategory(wikiId: string, text: string): Promise<CategoryMatch[]> {
  const onto = await getOntology(wikiId);
  const q = normMatch(text);
  if (!q) return [];
  const scored = onto.categories
    .map((c) => {
      const cands = [c.slug, c.label, ...(c.synonyms ?? [])].map(normMatch);
      const score = Math.max(0, ...cands.map((cand) => sim(q, cand)));
      return { slug: c.slug, label: c.label, score };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}
