import "server-only";
import { prisma } from "@/lib/db";
import { extractWikiTargets, normalizeSlug } from "@/lib/markdown";
import { reindexPage } from "@/lib/search";
import { KIND_LABEL } from "@/lib/kinds";
import type { TocSection, TocEntry, TocFolder, TocLeaf, WikiGraph, GraphNode, GraphEdge } from "@/lib/kinds";
import { isReservedSlug, ONTOLOGY_SLUG } from "@/lib/ontology";
import type { Prisma, PageKind, WikiKind, Visibility } from "@/generated/prisma/client";

// 페이지 생성/수정 공통 입력. category/sourceId는 undefined=미변경, null=해제, 값=설정.
type PageWrite = { title: string; kind: PageKind; body: string; category?: string | null; sourceId?: string | null };

// ---------- 슬러그 ----------
// check-then-create(TOCTOU) 대신 unique 위반(P2002)을 잡아 다음 접미로 재시도
const isP2002 = (e: unknown) => (e as { code?: string })?.code === "P2002";

// ---------- 위키 ----------
export function listWikisForUser(userId: string) {
  return prisma.wiki.findMany({
    where: { memberships: { some: { userId } } },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { pages: true } } },
  });
}

/** 내가 만든 위키. */
export function listOwnedWikis(userId: string) {
  return prisma.wiki.findMany({
    where: { createdById: userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { pages: true } } },
  });
}

/** 남이 나를 초대한 위키(내가 만들지 않았지만 멤버인 것) + 내 역할. */
export async function listSharedWikis(userId: string) {
  const rows = await prisma.wiki.findMany({
    where: { memberships: { some: { userId } }, NOT: { createdById: userId } },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { pages: true } },
      memberships: { where: { userId }, select: { role: true }, take: 1 },
      createdBy: { select: { name: true, email: true } },
    },
  });
  return rows.map((w) => ({ ...w, myRole: w.memberships[0]?.role }));
}

export async function createWiki(userId: string, input: { title: string; kind: WikiKind; description?: string }) {
  const root = normalizeSlug(input.title) || "wiki";
  for (let i = 0; ; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    try {
      return await prisma.wiki.create({
        data: {
          slug,
          title: input.title.trim() || "제목 없는 위키",
          description: input.description?.trim() || null,
          kind: input.kind,
          createdById: userId,
          memberships: { create: { userId, role: "owner" } },
        },
      });
    } catch (e) {
      if (isP2002(e) && i < 50) continue;
      throw e;
    }
  }
}

/** 접근 권한 확인과 함께 위키 조회. 멤버가 아니면 null */
export async function getWikiForUser(userId: string, slug: string) {
  const wiki = await prisma.wiki.findUnique({
    where: { slug },
    include: { memberships: { where: { userId }, take: 1 } },
  });
  if (!wiki || wiki.memberships.length === 0) return null;
  return { ...wiki, role: wiki.memberships[0].role };
}

export function listPages(wikiId: string) {
  return prisma.page.findMany({
    where: { wikiId },
    orderBy: [{ kind: "asc" }, { title: "asc" }],
    select: { id: true, slug: true, title: true, kind: true, updatedAt: true },
  });
}

export function getPage(wikiId: string, slug: string) {
  return prisma.page.findUnique({ where: { wikiId_slug: { wikiId, slug } } });
}

export async function existingSlugSet(wikiId: string): Promise<Set<string>> {
  const rows = await prisma.page.findMany({ where: { wikiId }, select: { slug: true } });
  return new Set(rows.map((r) => r.slug));
}

// ---------- 목차(TOC) 트리 ----------
// KIND_LABEL·Toc 타입은 클라이언트 공용 모듈에서 가져와 재수출(기존 server import 호환).
export { KIND_LABEL };
export type { TocSection, TocEntry };

/**
 * 위키의 페이지를 kind(카테고리)별 섹션으로 묶고, 각 섹션 안에서 parentId+sortOrder 트리로.
 * flat은 kind 순서 → 섹션 내 전위순회(이전/다음용). 사이드바·이전/다음·공개읽기가 이 하나를 공유.
 */
/**
 * 탐색기(VSCode식) 목차: 2섹션 — 원문/소스(note) vs 정리된 지식(파생, category 경로 폴더 트리).
 * flat은 섹션 순 전위순회(이전/다음용). getPrevNext는 이 flat만 쓰므로 시그니처 불변.
 */
export async function getWikiToc(wikiId: string): Promise<{ sections: TocSection[]; flat: { slug: string; title: string }[] }> {
  const pages = await prisma.page.findMany({
    where: { wikiId, slug: { not: ONTOLOGY_SLUG } }, // O1: system 온톨로지 페이지 숨김
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: { slug: true, title: true, kind: true, category: true },
  });

  // 원문/소스 = note(평평, category 없음)
  const sourceEntries: TocEntry[] = pages
    .filter((p) => p.kind === "note")
    .map((p) => ({ type: "page", slug: p.slug, title: p.title, kind: p.kind }));

  // 정리된 지식 = 파생 pages를 category 경로("ai/architectures")로 폴더 트리에 배치
  const rootChildren: TocEntry[] = [];
  const folderByPath = new Map<string, TocFolder>();
  const ensureFolder = (path: string): TocFolder => {
    const hit = folderByPath.get(path);
    if (hit) return hit;
    const parts = path.split("/");
    const folder: TocFolder = { type: "folder", name: parts[parts.length - 1], path, children: [] };
    folderByPath.set(path, folder);
    const parentPath = parts.slice(0, -1).join("/");
    if (parentPath) ensureFolder(parentPath).children.push(folder);
    else rootChildren.push(folder);
    return folder;
  };
  for (const p of pages) {
    if (p.kind === "note") continue;
    const leaf: TocLeaf = { type: "page", slug: p.slug, title: p.title, kind: p.kind };
    // 빈 세그먼트 정규화("ai/models/"·"ai//models" → "ai/models")로 빈 폴더/분열 방지
    const cat = p.category?.split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (cat) ensureFolder(cat).children.push(leaf);
    else rootChildren.push(leaf); // 미분류 파생은 섹션 루트에
  }

  const sections: TocSection[] = [];
  if (sourceEntries.length) sections.push({ key: "sources", label: "원문 / 소스", entries: sourceEntries });
  if (rootChildren.length) sections.push({ key: "knowledge", label: "정리된 지식", entries: rootChildren });

  const flat: { slug: string; title: string }[] = [];
  const walk = (entries: TocEntry[]) => {
    for (const e of entries) {
      if (e.type === "page") flat.push({ slug: e.slug, title: e.title });
      else walk(e.children);
    }
  };
  for (const s of sections) walk(s.entries);

  return { sections, flat };
}

/** 목차 순서 기준 이전/다음 페이지. 첫/마지막/미포함은 해당 방향 null. */
export async function getPrevNext(
  wikiId: string,
  slug: string,
): Promise<{ prev: { slug: string; title: string } | null; next: { slug: string; title: string } | null }> {
  const { flat } = await getWikiToc(wikiId);
  const i = flat.findIndex((f) => f.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return { prev: i > 0 ? flat[i - 1] : null, next: i < flat.length - 1 ? flat[i + 1] : null };
}

/** 새 페이지의 sortOrder = 형제 중 max+1 (끝에 append). */
async function nextSortOrder(wikiId: string, parentId: string | null): Promise<number> {
  const agg = await prisma.page.aggregate({ where: { wikiId, parentId }, _max: { sortOrder: true } });
  return (agg._max.sortOrder ?? -1) + 1;
}

// ---------- 위키 설정/공개 ----------
export function updateWikiSettings(
  wikiId: string,
  input: { title?: string; description?: string | null; visibility?: Visibility; kind?: WikiKind },
) {
  return prisma.wiki.update({
    where: { id: wikiId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() || "제목 없는 위키" } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    },
  });
}

export async function deleteWiki(wikiId: string) {
  const res = await prisma.wiki.delete({ where: { id: wikiId } }); // cascade로 pages/sources/chunks/members 등 삭제
  // DB cascade는 blob 원본을 지우지 않으므로 이 위키의 blob 접두사를 통째 정리(고아 방지, 비치명적)
  await import("@/lib/blob").then((m) => m.getBlobStore().deletePrefix(`${wikiId}/`)).catch(() => {});
  return res;
}

// ---------- 페이지 생성/수정 ----------
export async function createPage(wikiId: string, input: { title: string; kind: PageKind; body?: string; category?: string | null; sourceId?: string | null }) {
  const root = normalizeSlug(input.title) || "page";
  const sortOrder = await nextSortOrder(wikiId, null);
  let page;
  for (let i = 0; ; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    try {
      page = await prisma.page.create({
        data: {
          wikiId,
          slug,
          title: input.title.trim() || "제목 없음",
          kind: input.kind,
          body: input.body ?? "",
          sortOrder,
          category: input.category ?? null,
          sourceId: input.sourceId ?? null,
        },
      });
      break;
    } catch (e) {
      if (isP2002(e) && i < 50) continue;
      throw e;
    }
  }
  await recomputeLinks(wikiId, page.id, page.slug, page.body);
  await reindexPage(wikiId, page);
  return page;
}

export async function updatePage(wikiId: string, slug: string, input: PageWrite) {
  const page = await prisma.page.update({
    where: { wikiId_slug: { wikiId, slug } },
    data: {
      title: input.title.trim() || "제목 없음",
      kind: input.kind,
      body: input.body,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    },
  });
  await recomputeLinks(wikiId, page.id, page.slug, page.body);
  await reindexPage(wikiId, page);
  return page;
}

/**
 * slug를 명시해 생성/수정(에이전트 writePage용). slug가 이미 있으면 수정, 없으면 그 slug로 생성.
 * slug 미지정이면 title에서 유도(createPage).
 */
export async function upsertPage(
  wikiId: string,
  input: { slug?: string } & PageWrite,
): Promise<{ slug: string; created: boolean }> {
  const wanted = input.slug ? normalizeSlug(input.slug) : "";
  // O2: system 페이지(ontology 등)는 일반 경로로 쓸 수 없다. 온톨로지 변경은 setOntology 전용.
  if (wanted && isReservedSlug(wanted)) throw new Error(`예약된 system slug입니다: ${wanted}`);
  if (wanted) {
    const existing = await getPage(wikiId, wanted);
    if (existing) {
      await updatePage(wikiId, wanted, input);
      return { slug: wanted, created: false };
    }
    try {
      const page = await prisma.page.create({
        data: {
          wikiId,
          slug: wanted,
          title: input.title.trim() || "제목 없음",
          kind: input.kind,
          body: input.body,
          sortOrder: await nextSortOrder(wikiId, null),
          category: input.category ?? null,
          sourceId: input.sourceId ?? null,
        },
      });
      await recomputeLinks(wikiId, page.id, page.slug, page.body);
      await reindexPage(wikiId, page);
      return { slug: page.slug, created: true };
    } catch (e) {
      // 생성 직전 경합으로 같은 slug가 만들어졌으면 수정으로 폴백
      if (isP2002(e)) {
        await updatePage(wikiId, wanted, input);
        return { slug: wanted, created: false };
      }
      throw e;
    }
  }
  const page = await createPage(wikiId, input);
  return { slug: page.slug, created: true };
}

/**
 * 파생 페이지 삭제(에이전트 delete_page용). 호출부가 kind/예약슬러그를 먼저 검사한다
 * — 소스노트(note)와 원문(Source)은 불변 계층이라 이 경로로 지우지 않는다.
 * SearchChunk는 Page에 FK가 없어 cascade되지 않으므로 명시 삭제한다.
 * PageLink(out은 cascade, in은 SetNull)·PageContribution(cascade)은 Page 삭제로 정리된다.
 * 반환: 삭제했으면 true, 페이지가 없으면 false.
 */
export async function deletePage(wikiId: string, slug: string): Promise<boolean> {
  const page = await prisma.page.findUnique({
    where: { wikiId_slug: { wikiId, slug } },
    select: { id: true },
  });
  if (!page) return false;
  await prisma.$transaction([
    prisma.searchChunk.deleteMany({ where: { wikiId, refType: "page", refId: page.id } }),
    prisma.page.delete({ where: { id: page.id } }),
  ]);
  return true;
}

/**
 * 원문(Source) 삭제 시 영향받는 것들(삭제 전 경고 UI용).
 * - notes: 함께 삭제될 소스 노트(요약, 1:1 쌍)
 * - derived: 남지만 이 원문 출처를 잃는 정리된 지식(concept/entity, M:N 기여)
 */
export async function getSourceImpact(
  wikiId: string,
  sourceId: string,
): Promise<{ notes: { slug: string; title: string }[]; derived: { slug: string; title: string }[] }> {
  const [notes, contribs] = await Promise.all([
    prisma.page.findMany({ where: { wikiId, sourceId, kind: "note" }, select: { slug: true, title: true }, orderBy: { title: "asc" } }),
    prisma.pageContribution.findMany({
      where: { wikiId, sourceId },
      select: { page: { select: { slug: true, title: true } } },
      orderBy: { page: { title: "asc" } },
    }),
  ]);
  return { notes, derived: contribs.map((c) => c.page) };
}

/**
 * 원문(Source) 삭제. 연결된 소스 노트(요약)도 함께 지운다(1:1 쌍).
 * 정리된 지식(concept/entity)은 보존 — PageContribution(source cascade)만 끊겨 출처 표시가 빠진다(고아면 lint가 지적).
 * SearchChunk는 Source에 FK가 없어 cascade되지 않으므로 원문·노트 청크를 명시 삭제한다(deletePage와 동일 패턴).
 * 반환: 삭제했으면 함께 지운 노트 slug들, 원문이 없으면 null.
 */
export async function deleteSource(wikiId: string, slug: string): Promise<{ deletedNotes: string[] } | null> {
  const source = await prisma.source.findUnique({ where: { wikiId_slug: { wikiId, slug } }, select: { id: true, storageKey: true } });
  if (!source) return null;
  const notes = await prisma.page.findMany({ where: { wikiId, sourceId: source.id, kind: "note" }, select: { id: true, slug: true } });
  await prisma.$transaction([
    // 연결된 소스 노트: 페이지 청크(FK 없음 → 수동) + 페이지 삭제(out=cascade, in=SetNull→broken, PageContribution page=cascade)
    ...notes.flatMap((n) => [
      prisma.searchChunk.deleteMany({ where: { wikiId, refType: "page", refId: n.id } }),
      prisma.page.delete({ where: { id: n.id } }),
    ]),
    // 원문 청크(FK 없음 → 수동) + 원문(PageContribution source=cascade, 잔여 Page.sourceId=SetNull)
    prisma.searchChunk.deleteMany({ where: { wikiId, refType: "source", refId: source.id } }),
    prisma.source.delete({ where: { id: source.id } }),
  ]);
  // 원본 파일(blob) 동반 삭제 — DB 트랜잭션 커밋 뒤 best-effort(실패해도 삭제는 성립, 고아 blob 은 GC 대상)
  if (source.storageKey) await import("@/lib/blob").then((m) => m.getBlobStore().delete(source.storageKey!)).catch(() => {});
  return { deletedNotes: notes.map((n) => n.slug) };
}

/**
 * 이 페이지가 나가는 링크(PageLink)를 재계산하고,
 * 이 페이지 슬러그를 향해 깨져 있던 다른 페이지의 링크를 이 페이지로 연결한다.
 */
async function recomputeLinks(wikiId: string, pageId: string, slug: string, body: string) {
  const targets = extractWikiTargets(body);
  const existing = await prisma.page.findMany({
    where: { wikiId, slug: { in: targets.length ? targets : ["__none__"] } },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(existing.map((p) => [p.slug, p.id]));

  await prisma.$transaction([
    prisma.pageLink.deleteMany({ where: { fromPageId: pageId } }),
    prisma.pageLink.createMany({
      data: targets.map((t): Prisma.PageLinkCreateManyInput => ({
        wikiId,
        fromPageId: pageId,
        toSlug: t,
        toPageId: bySlug.get(t) ?? null,
      })),
    }),
    // 나를 가리키던 깨진 링크 연결
    prisma.pageLink.updateMany({
      where: { wikiId, toSlug: slug, toPageId: null },
      data: { toPageId: pageId },
    }),
  ]);
}

/** 이 페이지로 들어오는 백링크(출발 페이지 목록) */
export async function getBacklinks(wikiId: string, pageId: string) {
  const links = await prisma.pageLink.findMany({
    where: { wikiId, toPageId: pageId },
    select: { from: { select: { slug: true, title: true } } },
  });
  const seen = new Set<string>();
  const out: { slug: string; title: string }[] = [];
  for (const l of links) {
    if (seen.has(l.from.slug)) continue;
    seen.add(l.from.slug);
    out.push(l.from);
  }
  return out;
}

/** 이 페이지가 참조하는 문서(해소된 아웃링크 목록). 깨진 링크(toPageId null)는 제외. */
export async function getOutlinks(wikiId: string, pageId: string) {
  const links = await prisma.pageLink.findMany({
    where: { wikiId, fromPageId: pageId, toPageId: { not: null } },
    select: { to: { select: { slug: true, title: true } } },
  });
  const seen = new Set<string>();
  const out: { slug: string; title: string }[] = [];
  for (const l of links) {
    if (!l.to || seen.has(l.to.slug)) continue;
    seen.add(l.to.slug);
    out.push(l.to);
  }
  return out;
}

/** 이 페이지가 파생된 원문(provenance). sourceId 없으면 null. */
export async function getPageProvenance(wikiId: string, sourceId: string | null) {
  if (!sourceId) return null;
  return prisma.source.findFirst({
    where: { id: sourceId, wikiId },
    select: { slug: true, title: true, url: true },
  });
}

/** 원문(Source) 단건 조회(원문 뷰어용). */
export function getSource(wikiId: string, slug: string) {
  return prisma.source.findUnique({ where: { wikiId_slug: { wikiId, slug } } });
}

/** 원문(Source) id 목록 → slug/title (채팅 근거의 원문 히트 해소용, wikiId 스코프). */
export async function getSourcesByIds(
  wikiId: string,
  ids: string[],
): Promise<{ id: string; slug: string; title: string }[]> {
  if (ids.length === 0) return [];
  return prisma.source.findMany({ where: { wikiId, id: { in: ids } }, select: { id: true, slug: true, title: true } });
}

/** 파생 페이지 → 기여 원본 기록(멱등). ingest가 파생 페이지를 쓸 때 현재 run의 원본을 축적한다(여러 ingest에 걸쳐 누적). */
export async function addPageSource(wikiId: string, pageSlug: string, sourceId: string): Promise<void> {
  const [page, source] = await Promise.all([
    prisma.page.findUnique({ where: { wikiId_slug: { wikiId, slug: pageSlug } }, select: { id: true } }),
    prisma.source.findFirst({ where: { id: sourceId, wikiId }, select: { id: true } }), // 테넌트 격리: 원본도 같은 위키여야
  ]);
  if (!page || !source) return;
  await prisma.pageContribution.upsert({
    where: { pageId_sourceId: { pageId: page.id, sourceId } },
    create: { wikiId, pageId: page.id, sourceId },
    update: {},
  });
}

/** 이 파생 페이지가 유래한 원본(들). 기여 순(ingest 시각). note의 단일 provenance와 별개. */
export async function getPageSources(
  wikiId: string,
  pageId: string,
): Promise<{ slug: string; title: string; url: string | null }[]> {
  const rows = await prisma.pageContribution.findMany({
    where: { wikiId, pageId },
    select: { source: { select: { slug: true, title: true, url: true } } },
    orderBy: { source: { ingestedAt: "asc" } },
  });
  return rows.map((r) => r.source);
}

// ---------- P3: 그래프 ----------
/** 위키 전체 링크 그래프. 노드=페이지(ontology 제외), 엣지=해소된 위키링크. 깨진 링크는 ghost 노드로. */
export async function getWikiGraph(wikiId: string): Promise<WikiGraph> {
  const [pages, links] = await Promise.all([
    prisma.page.findMany({
      where: { wikiId, slug: { not: ONTOLOGY_SLUG } },
      select: { id: true, slug: true, title: true, kind: true, category: true },
    }),
    prisma.pageLink.findMany({ where: { wikiId }, select: { fromPageId: true, toPageId: true, toSlug: true } }),
  ]);
  const idToSlug = new Map(pages.map((p) => [p.id, p.slug]));
  const slugSet = new Set(pages.map((p) => p.slug));

  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  const brokenTargets = new Set<string>();
  const seen = new Set<string>(); // 중복 엣지 제거(source|target)
  const bump = (s: string) => degree.set(s, (degree.get(s) ?? 0) + 1);

  for (const l of links) {
    const source = idToSlug.get(l.fromPageId);
    if (!source) continue; // 노드 집합 밖(예: ontology) 출발 링크 스킵
    let target: string | undefined;
    if (l.toPageId) {
      target = idToSlug.get(l.toPageId);
    } else if (l.toSlug && !slugSet.has(l.toSlug) && !isReservedSlug(l.toSlug)) {
      target = l.toSlug; // 깨진 링크 → ghost
      brokenTargets.add(l.toSlug);
    }
    if (!target || target === source) continue;
    // 무방향 dedup: 양방향 링크(a↔b)를 한 엣지·degree +1 로(중복 카운트 방지)
    const lo = source < target ? source : target;
    const hi = source < target ? target : source;
    const key = `${lo} ${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source, target });
    bump(source);
    bump(target);
  }

  const nodes: GraphNode[] = pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    category: p.category,
    degree: degree.get(p.slug) ?? 0,
  }));
  for (const t of brokenTargets) {
    nodes.push({ slug: t, title: t, kind: null, category: null, degree: degree.get(t) ?? 0, broken: true });
  }
  return { nodes, edges };
}

/** 페이지 이웃 서브그래프(로컬 그래프). slug + depth홉 이내 노드/엣지. */
export async function getPageNeighborhood(wikiId: string, slug: string, depth = 1): Promise<WikiGraph> {
  const start = await prisma.page.findUnique({ where: { wikiId_slug: { wikiId, slug } }, select: { id: true } });
  if (!start) return { nodes: [], edges: [] };

  // BFS: 각 홉마다 프론티어 페이지의 in/out 해소링크만 조회(전체 그래프 로드 회피 — 핫 경로)
  const idSet = new Set<string>([start.id]);
  const edgePairs: [string, string][] = [];
  let frontier = [start.id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const links = await prisma.pageLink.findMany({
      where: { wikiId, toPageId: { not: null }, OR: [{ fromPageId: { in: frontier } }, { toPageId: { in: frontier } }] },
      select: { fromPageId: true, toPageId: true },
    });
    const next: string[] = [];
    for (const l of links) {
      const to = l.toPageId!;
      edgePairs.push([l.fromPageId, to]);
      for (const id of [l.fromPageId, to]) {
        if (!idSet.has(id)) {
          idSet.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const nodePages = await prisma.page.findMany({
    where: { wikiId, id: { in: [...idSet] }, slug: { not: ONTOLOGY_SLUG } },
    select: { id: true, slug: true, title: true, kind: true, category: true },
  });
  const idToSlug = new Map(nodePages.map((p) => [p.id, p.slug]));

  const degree = new Map<string, number>();
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const bump = (s: string) => degree.set(s, (degree.get(s) ?? 0) + 1);
  for (const [f, t] of edgePairs) {
    const s = idToSlug.get(f);
    const tg = idToSlug.get(t);
    if (!s || !tg || s === tg) continue; // 노드 집합 밖(ontology 등) 제외
    const lo = s < tg ? s : tg;
    const hi = s < tg ? tg : s;
    const key = `${lo} ${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: s, target: tg });
    bump(s);
    bump(tg);
  }
  const nodes: GraphNode[] = nodePages.map((p) => ({
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    category: p.category,
    degree: degree.get(p.slug) ?? 0,
  }));
  return { nodes, edges };
}
