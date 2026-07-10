"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { createWiki, getWikiForUser, getPage, createPage, updatePage, setPageCategory, listPages } from "@/lib/wiki";
import { MANUAL_KINDS } from "@/lib/kinds";
import { hasRole } from "@/lib/api-gate";
import { createIngestRun, createFileIngestRun, reapStaleRuns, fetchLinkMeta } from "@/lib/ingest";
import { classifyUpload, MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES } from "@/lib/file-types";
import { getOntology, ONTOLOGY_SLUG, isReservedSlug } from "@/lib/ontology";
import { normalizeSlug } from "@/lib/markdown";
import { reindexEmbeddings } from "@/lib/search";
import { normalizeCategoryForWrite } from "@/lib/governance";
import { checkDailyQuota } from "@/lib/usage";
import { prisma } from "@/lib/db";
import type { PageKind, WikiKind } from "@/generated/prisma/client";

// 쓰기 액션 공통: 멤버십 + editor 이상 역할 확인
async function requireWriteAccess(userId: string, wikiSlug: string) {
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  if (!hasRole(wiki.role, "editor")) throw new Error("쓰기 권한이 없습니다(editor 이상 필요)");
  return wiki;
}

// 생성형 LLM 서버액션(query/ingest) 공통: 일일 토큰 쿼터 초과 시 거부.
async function requireQuota(userId: string) {
  const q = await checkDailyQuota(userId);
  if (!q.ok) throw new Error(`일일 토큰 쿼터를 초과했습니다(${q.used}/${q.limit}). 내일 다시 시도하세요.`);
}

/** 새 페이지 모달용 카테고리 목록(lazy 로드). /new 페이지의 로딩과 동일 규약. */
export async function getWikiCategoriesAction(
  wikiSlug: string,
): Promise<{ slug: string; label: string; itemCount: number }[]> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) return [];
  const onto = await getOntology(wiki.id);
  return onto.categories.slice(0, 200).map((c) => ({ slug: c.slug, label: c.label, itemCount: c.itemCount ?? 0 }));
}

export async function createWikiAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const title = String(formData.get("title") ?? "");
  const kind = String(formData.get("kind") ?? "personal") as WikiKind;
  const wiki = await createWiki(userId, { title, kind });
  redirect(`/wikis/${encodeURIComponent(wiki.slug)}`);
}

export async function createPageAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const title = String(formData.get("title") ?? "");
  // 수동 생성은 concept/entity로 제한(폼 밖에서의 임의 kind 주입 방어). 미허용 값은 concept로 강등.
  const kindRaw = String(formData.get("kind") ?? "concept") as PageKind;
  const kind: PageKind = MANUAL_KINDS.includes(kindRaw) ? kindRaw : "concept";
  // 카테고리는 서버측 정규화(sanitize + 강한 문자열 매치면 canonical 흡수) — 표기 분기 예방
  const catRaw = String(formData.get("category") ?? "").trim();
  const category = catRaw ? await normalizeCategoryForWrite(wiki.id, catRaw) : null;
  const body = String(formData.get("body") ?? "");
  // 제목·종류·카테고리·본문을 한 화면에서 받아 곧바로 저장하고 페이지 뷰로 이동한다(별도 편집 단계 없음).
  const page = await createPage(wiki.id, { title, kind, category, body });
  revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 사이드바 TOC 갱신(폴더 "+"·수동 생성이 즉시 반영)
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(page.slug)}`);
}

export async function savePageAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const pageSlug = String(formData.get("pageSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const title = String(formData.get("title") ?? "");
  const submittedKind = String(formData.get("kind") ?? "") as PageKind;
  const body = String(formData.get("body") ?? "");
  // kind는 수동 kind(concept/entity)로만 변경 허용. 시스템 kind(note/meta)면 기존 값을 유지한다.
  const current = await getPage(wiki.id, pageSlug);
  const kind: PageKind = MANUAL_KINDS.includes(submittedKind) ? submittedKind : (current?.kind ?? "concept");
  await updatePage(wiki.id, pageSlug, { title, kind, body });
  revalidatePath(`/wikis/${wikiSlug}/${pageSlug}`);
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(pageSlug)}`);
}

// ---------- Obsidian식 개인 노트: 빠른 캡처 · 이동 · 핀 · 스위처 · 미해결 링크 ----------

/** 본문 첫 줄(마크다운 heading 마커 제거)로 제목 유도. Obsidian 빠른 캡처식. */
function firstLineTitle(body: string): string {
  const line = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return line.slice(0, 80) || "빈 노트";
}

// ---------- 읽을거리(read-later 링크) + 폴더 핀 ----------
const BARE_URL = /^https?:\/\/\S+$/i;
const isBareUrl = (s: string) => BARE_URL.test(s.trim());

/** 링크 저장(개인·자동 라벨). fetchLinkMeta는 LLM 없이 제목·설명 추출(잘못된/사설 URL이면 throw). */
async function saveLink(wikiId: string, userId: string, url: string): Promise<void> {
  const meta = await fetchLinkMeta(url);
  await prisma.savedLink.create({ data: { userId, wikiId, url, title: meta.title, description: meta.description } });
}

/** ⌘⇧N 빠른 캡처: 단일 URL이면 읽을거리로, 아니면 미분류(Inbox) 개인 노트로. */
export async function quickCaptureAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const body = String(formData.get("body") ?? "").trim();
  // "링크 붙여넣으면 읽을거리로, 텍스트면 노트로." 읽을거리는 개인 리스트라 멤버면 OK.
  if (isBareUrl(body)) {
    const wiki = await getWikiForUser(userId, wikiSlug);
    if (!wiki) throw new Error("접근 권한이 없습니다");
    await saveLink(wiki.id, userId, body);
    revalidatePath(`/wikis/${wikiSlug}/reading`);
    redirect(`/wikis/${encodeURIComponent(wikiSlug)}/reading`);
  }
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const page = await createPage(wiki.id, { title: firstLineTitle(body), kind: "personal", body, category: null });
  revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 사이드바 TOC(레이아웃) 갱신 — 새 노트가 '내 노트'에 즉시 노출
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(page.slug)}`);
}

/** 읽을거리에 링크 담기(전용 입력). 멤버면 OK — 개인 리스트. */
export async function saveLinkAction(wikiSlug: string, url: string): Promise<void> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  if (!isBareUrl(url)) throw new Error("올바른 URL이 아닙니다(http/https)");
  await saveLink(wiki.id, userId, url.trim());
  revalidatePath(`/wikis/${wikiSlug}/reading`);
}

/** 읽을거리 항목 삭제(소유 검증). */
export async function deleteSavedLinkAction(wikiSlug: string, id: string): Promise<void> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  await prisma.savedLink.deleteMany({ where: { id, userId, wikiId: wiki.id } });
  revalidatePath(`/wikis/${wikiSlug}/reading`);
}

/** 정식 편입: 읽을거리 링크를 기존 ingest 파이프라인에 넘기고 리스트에서 제거. runId 반환(상태 배지용). */
export async function promoteSavedLinkAction(wikiSlug: string, id: string): Promise<string> {
  const userId = await getCurrentUserId();
  const wiki = await requireWriteAccess(userId, wikiSlug); // 공유 지식에 씀 → editor+
  await requireQuota(userId);
  const link = await prisma.savedLink.findFirst({ where: { id, userId, wikiId: wiki.id } });
  if (!link) throw new Error("링크를 찾을 수 없습니다");
  if (link.promotedAt) throw new Error("이미 편입된 링크입니다"); // 중복 편입 방지
  const run = await createIngestRun(wiki.id, { url: link.url, title: link.title }, userId);
  // 삭제하지 않고 "편입됨"으로 표시 — 편입 후에도 링크를 계속 열어볼 수 있게(사용자가 삭제할 때까지 유지).
  await prisma.savedLink.update({ where: { id: link.id }, data: { promotedAt: new Date() } });
  revalidatePath(`/wikis/${wikiSlug}/reading`);
  return run.id;
}

/** 폴더(category) 핀 토글. 멤버면 OK — 개인 즐겨찾기. 반환: 토글 후 고정 상태. */
export async function toggleFolderPinAction(wikiSlug: string, category: string): Promise<boolean> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  const cat = category.trim();
  if (!cat) throw new Error("빈 폴더");
  const existing = await prisma.folderPin.findUnique({
    where: { userId_wikiId_category: { userId, wikiId: wiki.id, category: cat } },
    select: { id: true },
  });
  if (existing) {
    await prisma.folderPin.delete({ where: { id: existing.id } });
    revalidatePath(`/wikis/${wikiSlug}`, "layout");
    return false;
  }
  await prisma.folderPin.create({ data: { userId, wikiId: wiki.id, category: cat } });
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  return true;
}

/** 페이지를 폴더로 이동(refile). 빈 카테고리면 미분류(Inbox)로. 리다이렉트 없이 revalidate만(모달이 닫힘). */
export async function movePageAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const pageSlug = String(formData.get("pageSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const catRaw = String(formData.get("category") ?? "").trim();
  const category = catRaw ? await normalizeCategoryForWrite(wiki.id, catRaw) : null;
  await setPageCategory(wiki.id, pageSlug, category);
  revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 이동(refile) 후 사이드바 폴더 위치 갱신
  revalidatePath(`/wikis/${wikiSlug}/${pageSlug}`);
}

/** 핀 토글(개인 즐겨찾기). editor 아니라 멤버면 누구나 — 자기 사이드바 정리용. 반환: 토글 후 고정 상태. */
export async function togglePinAction(wikiSlug: string, pageSlug: string): Promise<boolean> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug); // 멤버면 OK(editor 불필요)
  if (!wiki) throw new Error("접근 권한이 없습니다");
  const page = await getPage(wiki.id, pageSlug);
  if (!page) throw new Error("페이지를 찾을 수 없습니다");
  const existing = await prisma.pagePin.findUnique({ where: { userId_pageId: { userId, pageId: page.id } }, select: { id: true } });
  if (existing) {
    await prisma.pagePin.delete({ where: { id: existing.id } });
    revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 사이드바 '고정됨' 목록 갱신
    return false;
  }
  await prisma.pagePin.create({ data: { userId, wikiId: wiki.id, pageId: page.id } });
  revalidatePath(`/wikis/${wikiSlug}`, "layout");
  return true;
}

/** ⌘P 빠른 이동(Quick Switcher) 데이터: 이 위키 페이지 제목 목록(개인 노트 포함, 온톨로지 제외). 테넌트 스코프. */
export async function listWikiPagesAction(wikiSlug: string): Promise<{ slug: string; title: string; kind: PageKind }[]> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) return []; // 비멤버엔 제목도 노출 안 함
  const pages = await listPages(wiki.id);
  return pages.filter((p) => p.slug !== ONTOLOGY_SLUG).map((p) => ({ slug: p.slug, title: p.title, kind: p.kind }));
}

/**
 * 미해결 [[link]]에서 페이지 생성. slug===target 불변(그래야 소스 페이지 링크가 자동 연결됨).
 * 이미 있으면 그 페이지로. kind=concept(지식 그래프 연결성 유지 — 개인 노트는 전용 플로우로만 생성).
 * 반환: 이동할 대상 slug.
 */
export async function createFromWikilinkAction(wikiSlug: string, targetSlug: string, category?: string | null): Promise<string> {
  const userId = await getCurrentUserId();
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const slug = normalizeSlug(targetSlug);
  if (!slug || isReservedSlug(slug)) throw new Error("유효하지 않은 링크 대상입니다");
  const existing = await getPage(wiki.id, slug);
  if (existing) return existing.slug; // 이미 있으면 그대로 이동
  const cat = category ? await normalizeCategoryForWrite(wiki.id, category) : null;
  const page = await createPage(wiki.id, { title: slug, kind: "concept", body: "", slug, category: cat });
  revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 미해결 링크로 생성된 페이지가 사이드바에 즉시 노출
  return page.slug;
}

export async function ingestAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  await requireQuota(userId);
  const url = String(formData.get("url") ?? "").trim() || undefined;
  const text = String(formData.get("text") ?? "").trim() || undefined;
  const title = String(formData.get("title") ?? "").trim() || undefined;
  const rawFiles = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!url && !text && rawFiles.length === 0) throw new Error("URL·텍스트·파일 중 하나가 필요합니다");

  // 파일은 부수효과(blob 저장·잡 생성) 전에 전량 선검증한다 — 한 파일이 실패해도 일부만 커밋되지 않도록.
  const files = await Promise.all(
    rawFiles.map(async (f) => ({ file: f, buffer: Buffer.from(await f.arrayBuffer()) })),
  );
  if (files.length) {
    const total = files.reduce((s, f) => s + f.buffer.length, 0);
    if (total > MAX_REQUEST_BYTES) throw new Error(`업로드 총량이 너무 큽니다(최대 ${Math.floor(MAX_REQUEST_BYTES / 1024 / 1024)}MB)`);
    for (const { file, buffer } of files) {
      if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`${file.name}: 파일이 너무 큽니다(최대 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
      const cls = classifyUpload(buffer, file.name);
      if ("rejected" in cls) throw new Error(`${file.name}: ${cls.rejected}`);
    }
  }

  // 검증 통과 후에만 잡 생성(비동기: 처리는 별도 worker). ?run=으로 첫 잡의 상태 배지 표시.
  let firstRunId: string | undefined;
  if (url || text) {
    const run = await createIngestRun(wiki.id, { url, text, title }, userId);
    firstRunId ??= run.id;
  }
  for (const { file, buffer } of files) {
    const run = await createFileIngestRun(wiki.id, { buffer, filename: file.name, mimeType: file.type || undefined }, userId);
    firstRunId ??= run.id;
  }
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}${firstRunId ? `?run=${firstRunId}` : ""}`);
}

export type RunListItem = {
  id: string;
  type: string;
  status: string;
  title: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  pagesTouched: number;
  costUSD: number | null;
  totalTokens: number | null;
};

/** 최근 에이전트 잡 목록(전역 잡 인디케이터 폴링용). 세션 인증 + wiki 스코프. */
export async function listRunsAction(wikiSlug: string): Promise<RunListItem[] | null> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) return null;
  await reapStaleRuns(wiki.id).catch(() => {}); // 크래시로 고착된 잡 기회적 회수
  const runs = await prisma.agentRun.findMany({
    where: { wikiId: wiki.id },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  return runs.map((r) => {
    const input = (r.input ?? {}) as { title?: string; url?: string; text?: string };
    const output = (r.output ?? {}) as {
      pagesTouched?: string[];
      costUSD?: number;
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    };
    const u = output.usage;
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      title: input.title?.trim() || input.url || input.text?.slice(0, 40) || r.type,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      error: r.error,
      pagesTouched: Array.isArray(output.pagesTouched) ? output.pagesTouched.length : 0,
      costUSD: typeof output.costUSD === "number" ? output.costUSD : null,
      totalTokens: u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : null,
    };
  });
}

/** ingest 잡 상태 조회(진행 배지 폴링용). 세션 인증 + wiki 스코프. */
export async function getRunStatusAction(
  wikiSlug: string,
  runId: string,
): Promise<{ status: string; error: string | null; summary: string | null; pagesTouched: number } | null> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) return null;
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.wikiId !== wiki.id) return null;
  const output = (run.output ?? {}) as { summary?: string; pagesTouched?: string[] };
  return {
    status: run.status,
    error: run.error,
    summary: typeof output.summary === "string" ? output.summary : null,
    pagesTouched: Array.isArray(output.pagesTouched) ? output.pagesTouched.length : 0,
  };
}

export async function reindexAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  await reindexEmbeddings(wiki.id);
  revalidatePath(`/wikis/${wikiSlug}`);
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
}

export async function searchAction(formData: FormData) {
  const wikiSlug = String(formData.get("wikiSlug"));
  const q = String(formData.get("q") ?? "").trim();
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}?q=${encodeURIComponent(q)}`);
}
