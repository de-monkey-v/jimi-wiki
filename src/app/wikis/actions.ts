"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { createWiki, getWikiForUser, getPage, createPage, updatePage } from "@/lib/wiki";
import { MANUAL_KINDS } from "@/lib/kinds";
import { hasRole } from "@/lib/api-gate";
import { createIngestRun, reapStaleRuns } from "@/lib/ingest";
import { reindexEmbeddings } from "@/lib/search";
import { answerQuery } from "@/lib/query";
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
  // kind는 수동 kind(concept/entity)로만 변경 허용. 시스템 kind(note/answer/meta)면 기존 값을 유지한다.
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
  if (!url && !text) throw new Error("URL 또는 텍스트가 필요합니다");
  // 비동기: 잡만 생성하고 즉시 반환, 처리는 별도 worker가 수행. ?run=으로 상태 배지 표시.
  const run = await createIngestRun(wiki.id, { url, text, title }, userId);
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}?run=${run.id}`);
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

/** 질문 → 검색+합성 답변을 answer 페이지로 저장 후 그 페이지로 이동(탐색 축적). editor 이상. */
export async function queryAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  await requireQuota(userId);
  const question = String(formData.get("question") ?? "").trim();
  if (!question) redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
  const res = await answerQuery(wiki.id, question, { save: true, userId });
  if (res.savedSlug) {
    redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(res.savedSlug)}`);
  }
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
}
