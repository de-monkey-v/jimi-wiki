"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getCurrentUserId } from "@/lib/session";
import { createWiki, getWikiForUser, createPage, updatePage } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { createIngestRun, runIngestJob, reapStaleRuns } from "@/lib/ingest";
import { reindexEmbeddings } from "@/lib/search";
import { answerQuery } from "@/lib/query";
import { prisma } from "@/lib/db";
import type { PageKind, WikiKind } from "@/generated/prisma/client";

// 쓰기 액션 공통: 멤버십 + editor 이상 역할 확인
async function requireWriteAccess(userId: string, wikiSlug: string) {
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  if (!hasRole(wiki.role, "editor")) throw new Error("쓰기 권한이 없습니다(editor 이상 필요)");
  return wiki;
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
  const kind = String(formData.get("kind") ?? "note") as PageKind;
  const category = String(formData.get("category") ?? "").trim() || null;
  const page = await createPage(wiki.id, { title, kind, category });
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(page.slug)}/edit`);
}

export async function savePageAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const pageSlug = String(formData.get("pageSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const title = String(formData.get("title") ?? "");
  const kind = String(formData.get("kind") ?? "note") as PageKind;
  const body = String(formData.get("body") ?? "");
  await updatePage(wiki.id, pageSlug, { title, kind, body });
  revalidatePath(`/wikis/${wikiSlug}/${pageSlug}`);
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(pageSlug)}`);
}

export async function ingestAction(formData: FormData) {
  const userId = await getCurrentUserId();
  const wikiSlug = String(formData.get("wikiSlug"));
  const wiki = await requireWriteAccess(userId, wikiSlug);
  const url = String(formData.get("url") ?? "").trim() || undefined;
  const text = String(formData.get("text") ?? "").trim() || undefined;
  const title = String(formData.get("title") ?? "").trim() || undefined;
  if (!url && !text) throw new Error("URL 또는 텍스트가 필요합니다");
  // 비동기: 잡만 생성하고 즉시 반환, 처리는 백그라운드(after). ?run=으로 상태 배지 표시.
  const run = await createIngestRun(wiki.id, { url, text, title }, userId);
  after(() =>
    runIngestJob({ id: run.id, wikiId: wiki.id, input: { url, text, title }, userId }).catch((e) =>
      console.error(`[ingest] runIngestJob 실패: ${(e as Error).message}`),
    ),
  );
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
  const question = String(formData.get("question") ?? "").trim();
  if (!question) redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
  const res = await answerQuery(wiki.id, question, { save: true });
  if (res.savedSlug) {
    redirect(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(res.savedSlug)}`);
  }
  redirect(`/wikis/${encodeURIComponent(wikiSlug)}`);
}
