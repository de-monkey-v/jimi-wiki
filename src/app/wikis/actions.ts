"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { createWiki, getWikiForUser, getPage, createPage, updatePage } from "@/lib/wiki";
import { MANUAL_KINDS } from "@/lib/kinds";
import { hasRole } from "@/lib/api-gate";
import { createIngestRun, createFileIngestRun, reapStaleRuns } from "@/lib/ingest";
import { classifyUpload, MAX_UPLOAD_BYTES, MAX_REQUEST_BYTES } from "@/lib/file-types";
import { getOntology } from "@/lib/ontology";
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
