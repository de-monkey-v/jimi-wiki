import "server-only";
import { prisma } from "@/lib/db";
import {
  getOntology,
  setOntology,
  sanitizeCategorySlug,
  matchCategory,
  listCategories,
  ONTOLOGY_SLUG,
  PROMOTION_MIN_ITEMS,
  type OntologyCategory,
} from "@/lib/ontology";
import {
  indexCategory,
  deleteCategoryChunk,
  findSimilarCategories,
  matchCategorySemantic,
} from "@/lib/search";

// category 거버넌스는 ontology.ts + search.ts 를 모두 조율하지만 그 둘은 governance를 import하지 않는다(순환 회피).

const categoryText = (c: OntologyCategory) => [c.label, ...(c.synonyms ?? []), c.slug].join(" ");
const uniq = (arr: (string | null | undefined)[]) => [...new Set(arr.filter((s): s is string => !!s))];

async function log(wikiId: string, title: string, detail: string) {
  await prisma.logEntry.create({ data: { wikiId, kind: "ontology", title, detail } });
}

/** 코퍼스를 온톨로지 문서와 재동기화: 문서에 없는 category 청크 삭제 + 문서 category 전부 재인덱싱. */
async function resyncCorpus(wikiId: string): Promise<void> {
  const onto = await getOntology(wikiId);
  const docSlugs = new Set(onto.categories.map((c) => c.slug));
  const existing = await prisma.searchChunk.findMany({ where: { wikiId, refType: "category" }, select: { refId: true } });
  for (const r of existing) {
    const slug = r.refId.replace(/^category:/, "");
    if (!docSlugs.has(slug)) await deleteCategoryChunk(wikiId, slug).catch(() => {});
  }
  for (const c of onto.categories) await indexCategory(wikiId, c.slug, categoryText(c)).catch(() => {});
}

/**
 * Page.category 변경 후 재조정. **add-only**: 실제 페이지에 있으나 문서에 없는 category만 추가한다.
 * 고아(페이지 없는) category는 삭제하지 않는다 — 사용자가 lint에서 검토 중인 고아·큐레이션된 synonym을 보존하기 위함.
 * (merge/rename의 하위경로 이동으로 생긴 신규 category는 여기서 회수. 명시적 제거는 각 op의 setOntology mutate가 담당.)
 */
async function reconcile(wikiId: string): Promise<void> {
  const [used, onto] = await Promise.all([listCategories(wikiId), getOntology(wikiId)]);
  const have = new Set(onto.categories.map((c) => c.slug));
  const toAdd = uniq(used.map((c) => sanitizeCategorySlug(c))).filter((s) => !have.has(s));
  if (toAdd.length) {
    await setOntology(wikiId, (doc) => {
      const h = new Set(doc.categories.map((c) => c.slug));
      for (const s of toAdd) {
        if (h.has(s)) continue;
        doc.categories.push({ slug: s, label: s.split("/").pop() ?? s, itemCount: 0 });
        h.add(s);
      }
      return doc;
    });
  }
  await resyncCorpus(wikiId);
}

/** Page.category 벌크 이동: exact(from) + subpath(from/*). to=null이면 미분류. slug의 `_`가 LIKE 와일드카드라 left()로 접두 비교. */
async function movePageCategories(wikiId: string, from: string, to: string | null): Promise<void> {
  if (to === null) {
    await prisma.$executeRawUnsafe(`UPDATE "Page" SET category=NULL WHERE "wikiId"=$1 AND category=$2`, wikiId, from);
    await prisma.$executeRawUnsafe(
      `UPDATE "Page" SET category=NULL WHERE "wikiId"=$1 AND left(category, length($2)+1) = $2 || '/'`,
      wikiId,
      from,
    );
    return;
  }
  await prisma.$executeRawUnsafe(`UPDATE "Page" SET category=$3 WHERE "wikiId"=$1 AND category=$2`, wikiId, from, to);
  await prisma.$executeRawUnsafe(
    `UPDATE "Page" SET category = $3 || substring(category, length($2)+1) WHERE "wikiId"=$1 AND left(category, length($2)+1) = $2 || '/'`,
    wikiId,
    from,
    to,
  );
}

/** category 이름변경(하위 경로 포함). 기존 이름은 synonym으로 보존(가역). to가 이미 있으면 병합으로 위임. */
export async function renameCategory(wikiId: string, from: string, toRaw: string): Promise<void> {
  const to = sanitizeCategorySlug(toRaw);
  if (!to) throw new Error("유효하지 않은 category 이름");
  if (to === from) return;
  const onto = await getOntology(wikiId);
  if (onto.categories.some((c) => c.slug === to)) return mergeCategory(wikiId, from, to);

  await movePageCategories(wikiId, from, to);
  await setOntology(wikiId, (doc) => {
    for (const c of doc.categories) {
      if (c.slug === from) {
        c.synonyms = uniq([...(c.synonyms ?? []), c.label, from]);
        c.slug = to;
        c.label = to.split("/").pop() ?? to;
      } else if (c.slug.startsWith(from + "/")) {
        c.slug = to + c.slug.slice(from.length);
      }
    }
    // 재키잉으로 기존 형제와 slug가 충돌하면 병합(중복 엔트리 방지) — mergeCategory와 동일 패턴
    const bySlug = new Map<string, OntologyCategory>();
    for (const c of doc.categories) {
      const existing = bySlug.get(c.slug);
      if (existing) existing.synonyms = uniq([...(existing.synonyms ?? []), ...(c.synonyms ?? []), c.label]);
      else bySlug.set(c.slug, c);
    }
    doc.categories = [...bySlug.values()];
    return doc;
  });
  await reconcile(wikiId);
  await log(wikiId, "category rename", `${from} → ${to}`);
}

/** category 병합: from의 페이지·synonym을 into로 흡수하고 from 제거(가역: synonym 이력 보존). */
export async function mergeCategory(wikiId: string, from: string, into: string): Promise<void> {
  if (from === into) return;
  const onto = await getOntology(wikiId);
  if (!onto.categories.some((c) => c.slug === into)) throw new Error(`병합 대상 category 없음: ${into}`);

  await movePageCategories(wikiId, from, into);
  await setOntology(wikiId, (doc) => {
    const fromEntry = doc.categories.find((c) => c.slug === from);
    const intoEntry = doc.categories.find((c) => c.slug === into);
    if (intoEntry && fromEntry) {
      intoEntry.synonyms = uniq([...(intoEntry.synonyms ?? []), ...(fromEntry.synonyms ?? []), fromEntry.label, from]);
    }
    // exact from은 into로 흡수, 자식 from/*은 into/*로 re-key(라벨·synonym 메타데이터 보존)
    const bySlug = new Map<string, OntologyCategory>();
    for (const c of doc.categories) {
      if (c.slug === from) continue;
      if (c.slug.startsWith(from + "/")) c.slug = into + c.slug.slice(from.length);
      const existing = bySlug.get(c.slug);
      if (existing) existing.synonyms = uniq([...(existing.synonyms ?? []), ...(c.synonyms ?? []), c.label]);
      else bySlug.set(c.slug, c);
    }
    doc.categories = [...bySlug.values()];
    return doc;
  });
  await reconcile(wikiId);
  await log(wikiId, "category merge", `${from} → ${into}`);
}

/** category 폐기: reassignTo 있으면 병합, 없으면 해당(및 하위) 페이지를 미분류로. */
export async function retireCategory(wikiId: string, slug: string, reassignTo?: string | null): Promise<void> {
  if (reassignTo) return mergeCategory(wikiId, slug, reassignTo);
  await movePageCategories(wikiId, slug, null);
  await setOntology(wikiId, (doc) => {
    doc.categories = doc.categories.filter((c) => c.slug !== slug && !c.slug.startsWith(slug + "/"));
    return doc;
  });
  await reconcile(wikiId);
  await log(wikiId, "category retire", slug);
}

/** 페이지 1건에 category 지정(정규화). null이면 미분류. 이후 온톨로지/코퍼스 동기화. */
export async function setPageCategory(wikiId: string, pageSlug: string, categoryRaw: string | null): Promise<void> {
  const category = categoryRaw ? sanitizeCategorySlug(categoryRaw) : null;
  await prisma.page.update({ where: { wikiId_slug: { wikiId, slug: pageSlug } }, data: { category } });
  await reconcile(wikiId);
}

/** 온톨로지의 itemCount를 실제 페이지에서 재계산(증분 카운터 금지, C3). */
export async function recountItemCounts(wikiId: string): Promise<void> {
  const rows = await prisma.page.groupBy({ by: ["category"], where: { wikiId, category: { not: null } }, _count: true });
  const counts = new Map(rows.map((r) => [r.category as string, r._count]));
  const onto = await getOntology(wikiId);
  // 변화 없으면 write 안 함(lint는 읽기 — 매 로드 version/log churn·CAS 경합 방지)
  if (!onto.categories.some((c) => (c.itemCount ?? 0) !== (counts.get(c.slug) ?? 0))) return;
  await setOntology(wikiId, (doc) => {
    for (const c of doc.categories) c.itemCount = counts.get(c.slug) ?? 0;
    return doc;
  });
}

/** REST 쓰기용 category 정규화(S3): sanitize + 강한 문자열 매치면 canonical로 흡수. 시맨틱 auto-merge는 안 함(O4). */
export async function normalizeCategoryForWrite(wikiId: string, raw: string): Promise<string | null> {
  const s = sanitizeCategorySlug(raw);
  if (!s) return null;
  const cands = await matchCategory(wikiId, s);
  // 정확 정규화 일치(대소문자/공백/구분자 차)만 canonical로 흡수. substring/조상-자손 관계는 스냅 금지(오배치 방지).
  if (cands[0] && cands[0].score >= 0.999) return cands[0].slug;
  return s;
}

export interface CategoryIssues {
  nearDup: { a: string; b: string; sim: number }[];
  orphanCats: string[];
  uncategorized: { slug: string; title: string }[];
  deepSparse: { slug: string; depth: number; itemCount: number }[];
}

// 너무 깊다고 보는 최소 깊이(3단 이상 = ai/models/generative). 하위 페이지가 PROMOTION_MIN_ITEMS 미만이면 희소.
const DEEP_MIN_DEPTH = 3;

/** lint용 category 건강 탐지: 중복 의심 쌍 + 고아 category + 미분류 파생 페이지 + 과깊이·희소 category. */
export async function detectCategoryIssues(wikiId: string): Promise<CategoryIssues> {
  const [nearDup, onto, live, derived] = await Promise.all([
    findSimilarCategories(wikiId, 0.82),
    getOntology(wikiId),
    listCategories(wikiId),
    prisma.page.findMany({
      where: { wikiId, kind: { notIn: ["note", "meta"] } },
      select: { slug: true, title: true, category: true },
    }),
  ]);
  const liveSet = new Set(live);
  const orphanCats = onto.categories.map((c) => c.slug).filter((s) => !liveSet.has(s));
  // 미분류 = category 없음 OR category가 sanitize와 불일치(오염·과깊이 → 문서에 못 들어감 = 실질 미분류/고아 페이지)
  const uncategorized = derived
    .filter((p) => p.slug !== ONTOLOGY_SLUG && (!p.category || sanitizeCategorySlug(p.category) !== p.category))
    .map((p) => ({ slug: p.slug, title: p.title }));
  // 과깊이·희소: 3단+ 인데 하위 페이지가 승격 임계 미만 → 상위로 흡수(평탄화) 제안. itemCount는 recountItemCounts 후 값.
  const deepSparse = onto.categories
    .filter((c) => c.slug.split("/").length >= DEEP_MIN_DEPTH && (c.itemCount ?? 0) < PROMOTION_MIN_ITEMS)
    .map((c) => ({ slug: c.slug, depth: c.slug.split("/").length, itemCount: c.itemCount ?? 0 }));
  return { nearDup, orphanCats, uncategorized, deepSparse };
}

/** 미분류 파생 페이지에 대해 재사용 후보 제안(자동 적용 아님 — 사용자 승인용). */
export async function suggestCategoriesForUncategorized(
  wikiId: string,
): Promise<{ slug: string; title: string; candidates: { slug: string; score: number }[] }[]> {
  const { uncategorized } = await detectCategoryIssues(wikiId);
  const out = [];
  for (const p of uncategorized.slice(0, 20)) {
    const [str, vec] = await Promise.all([matchCategory(wikiId, p.title), matchCategorySemantic(wikiId, p.title)]);
    const bySlug = new Map<string, number>();
    for (const c of str) bySlug.set(c.slug, c.score);
    for (const c of vec) bySlug.set(c.slug, Math.max(bySlug.get(c.slug) ?? 0, c.score));
    const candidates = [...bySlug.entries()].map(([slug, score]) => ({ slug, score })).sort((a, b) => b.score - a.score).slice(0, 3);
    out.push({ slug: p.slug, title: p.title, candidates });
  }
  return out;
}
