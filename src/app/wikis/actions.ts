"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { createWiki, getWikiForUser, getPage, createPage, updatePage, setPageCategory, listPages } from "@/lib/wiki";
import { MANUAL_KINDS } from "@/lib/kinds";
import { hasRole } from "@/lib/api-gate";
import { createIngestRun, createFileIngestRun, reapStaleRuns } from "@/lib/ingest";
import { classifyUpload, MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES } from "@/lib/file-types";
import { getOntology, ONTOLOGY_SLUG, isReservedSlug } from "@/lib/ontology";
import { normalizeSlug } from "@/lib/markdown";
import { reindexEmbeddings } from "@/lib/search";
import { normalizeCategoryForWrite } from "@/lib/governance";
import { checkDailyQuota } from "@/lib/usage";
import { prisma } from "@/lib/db";
import type { ModelAccess, PageKind, WikiKind } from "@/generated/prisma/client";
import { promoteSavedLink } from "@/lib/saved-link-promotion";
import { parseDocumentDate, parseDocumentType, writeDocument } from "@/lib/documents";
import { saveSavedLink, trashSavedLink } from "@/lib/saved-links";
import { saveFolderSortPreference } from "@/lib/folder-sort.server";
import type { FolderSortSelection } from "@/lib/folder-sort";

function formModelAccess(formData: FormData): ModelAccess {
  return String(formData.get("modelAccess") ?? "external") === "internalOnly" ? "internalOnly" : "external";
}

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
  const rawKind = String(formData.get("kind") ?? "personal");
  const kind: WikiKind = rawKind === "project" ? "project" : "personal";
  const wiki = await createWiki(userId, { title, kind });
  redirect(`/wikis/${encodeURIComponent(wiki.slug)}`);
}

export async function createPageAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const title = String(formData.get("title") ?? "");
  // 수동 생성은 닫힌 MANUAL_KINDS 집합으로 제한한다.
  const kindRaw = String(formData.get("kind") ?? "concept") as PageKind;
  const kind: PageKind = MANUAL_KINDS.includes(kindRaw) ? kindRaw : "concept";
  // 카테고리는 서버측 정규화(sanitize + 강한 문자열 매치면 canonical 흡수) — 표기 분기 예방
  const catRaw = String(formData.get("category") ?? "").trim();
  const category = catRaw ? await normalizeCategoryForWrite(wiki.id, catRaw) : null;
  const body = String(formData.get("body") ?? "");
  const modelAccess = formModelAccess(formData);
  // document는 source provenance를 가질 수 없는 전용 writer를 통해 생성한다.
  let page;
  if (kind === "document") {
    const result = await writeDocument({
        wikiId: wiki.id,
        userId,
        actor: "human",
        externalAgent: false,
        title,
        body,
        documentType: parseDocumentType(formData.get("documentType"), "general") ?? "general",
        documentAt: parseDocumentDate(formData.get("documentAt"), new Date()) ?? new Date(),
        category,
      });
    if (result.staged) throw new Error("사람이 작성한 새 문서는 검토 초안으로 전환되지 않습니다");
    page = result.page;
  } else {
    page = await createPage(wiki.id, { title, kind, category, body, modelAccess, userId });
  }
  revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 사이드바 TOC 갱신(폴더 "+"·수동 생성이 즉시 반영)
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(page.slug)}`);
}

export async function savePageAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const pageSlug = String(formData.get("pageSlug"));
  if (isReservedSlug(pageSlug)) throw new Error("system page는 일반 편집할 수 없습니다");
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const title = String(formData.get("title") ?? "");
  const submittedKind = String(formData.get("kind") ?? "") as PageKind;
  const body = String(formData.get("body") ?? "");
  const expectedVersion = Number(formData.get("expectedVersion"));
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) throw new Error("유효한 page version이 필요합니다");
  // document와 지식 페이지 사이 변환은 금지한다. 문서 metadata는 revision마다 함께 보존한다.
  const current = await getPage(wiki.id, pageSlug);
  if (!current) throw new Error("페이지를 찾을 수 없습니다");
  const kind: PageKind = current.kind === "document"
    ? "document"
    : submittedKind === "document"
      ? current.kind
      : MANUAL_KINDS.includes(submittedKind) ? submittedKind : current.kind;
  const documentType = current.kind === "document"
    ? parseDocumentType(formData.get("documentType"), current.documentType ?? "general")
    : null;
  const documentAt = current.kind === "document"
    ? parseDocumentDate(formData.get("documentAt"), current.documentAt ?? new Date())
    : null;
  if (current.kind === "document" && (!documentType || !documentAt)) throw new Error("유효한 문서 메타데이터가 필요합니다");
  await updatePage(wiki.id, pageSlug, {
    title,
    kind,
    body,
    userId,
    expectedVersion,
    documentType,
    documentAt,
  });
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

/** 링크 저장(개인·자동 라벨). 메타데이터만 읽으며 LLM은 호출하지 않는다. */
async function saveLink(wikiId: string, userId: string, url: string): Promise<void> {
  await saveSavedLink({ wikiId, userId, url });
}

/** 폴더 정렬 개인 설정. viewer를 포함한 모든 멤버가 자기 행만 변경한다. */
export async function setFolderSortPreferenceAction(
  wikiSlug: string,
  category: string,
  selection: unknown,
): Promise<FolderSortSelection> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  const saved = await saveFolderSortPreference(userId, wiki.id, category, selection);
  const encodedWiki = encodeURIComponent(wikiSlug);
  const encodedCategory = category.split("/").map(encodeURIComponent).join("/");
  revalidatePath(`/wikis/${encodedWiki}`, "layout");
  revalidatePath(`/wikis/${encodedWiki}/category/${encodedCategory}`);
  return saved;
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
  const page = await createPage(wiki.id, {
    title: firstLineTitle(body),
    kind: "personal",
    body,
    category: null,
    modelAccess: "internalOnly",
    userId,
  });
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

/** 읽을거리 항목을 14일 복구 가능한 휴지통으로 이동(소유 검증). */
export async function deleteSavedLinkAction(wikiSlug: string, id: string): Promise<void> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  await trashSavedLink(wiki.id, userId, id);
  revalidatePath(`/wikis/${wikiSlug}/reading`);
}

/** 정식 편입: 읽을거리 링크를 기존 ingest 파이프라인에 넘기고 리스트에서 제거. runId 반환(상태 배지용). */
export async function promoteSavedLinkAction(wikiSlug: string, id: string): Promise<string> {
  const userId = await getCurrentUserId();
  const wiki = await requireWriteAccess(userId, wikiSlug); // 공유 지식에 씀 → editor+
  const link = await prisma.savedLink.findFirst({ where: { id, userId, wikiId: wiki.id, trashedAt: null } });
  if (!link) throw new Error("링크를 찾을 수 없습니다");
  if (!link.promotedRunId && !link.promotedAt) await requireQuota(userId);
  const promotion = await promoteSavedLink(wiki.id, userId, id);
  revalidatePath(`/wikis/${wikiSlug}/reading`);
  if (!promotion.runId) throw new Error("이미 편입된 링크입니다");
  return promotion.runId;
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
  if (isReservedSlug(pageSlug)) throw new Error("system page는 이동할 수 없습니다");
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const catRaw = String(formData.get("category") ?? "").trim();
  const category = catRaw ? await normalizeCategoryForWrite(wiki.id, catRaw) : null;
  const expectedVersion = Number(formData.get("expectedVersion"));
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) throw new Error("유효한 page version이 필요합니다");
  await setPageCategory(wiki.id, pageSlug, category, expectedVersion, userId);
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
  const page = await createPage(wiki.id, { title: slug, kind: "concept", body: "", slug, category: cat, userId });
  revalidatePath(`/wikis/${wikiSlug}`, "layout"); // 미해결 링크로 생성된 페이지가 사이드바에 즉시 노출
  return page.slug;
}

export async function ingestAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const modelAccess = formModelAccess(formData);
  if (modelAccess === "external") await requireQuota(userId);
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
    const run = await createIngestRun(wiki.id, { url, text, title, modelAccess }, userId);
    firstRunId ??= run.id;
  }
  for (const { file, buffer } of files) {
    const run = await createFileIngestRun(
      wiki.id,
      { buffer, filename: file.name, mimeType: file.type || undefined, modelAccess },
      userId,
    );
    firstRunId ??= run.id;
  }
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}${firstRunId ? `?run=${firstRunId}` : ""}`);
}

export type RunListItem = {
  id: string;
  type: string;
  status: string;
  stage: string | null; // running 중 현재 단계(fetch|curate|embed|lint). 종료 시 null
  title: string;
  createdAt: string; // 큐 진입 시각
  startedAt: string | null; // 실제 실행 시작(running 전이) 시각. 대기 중이면 null
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
      stage: r.stage,
      title: input.title?.trim() || input.url || input.text?.slice(0, 40) || r.type,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
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
