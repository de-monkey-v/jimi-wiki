"use server";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, upsertPage, getPage, getSource, getBacklinks, getOutlinks, existingSlugSet } from "@/lib/wiki";
import { renderMarkdown } from "@/lib/markdown";
import { hasRole } from "@/lib/api-gate";
import { prisma } from "@/lib/db";

/** 채팅 근거 문서(page 또는 원문)를 렌더된 HTML + 관련 문서(모달 내 이어보기용)로 반환. 세션 인증 + wiki 스코프. */
export async function fetchEvidenceDoc(
  wikiSlug: string,
  kind: "page" | "source",
  slug: string,
): Promise<{
  title: string;
  html: string;
  url: string | null;
  empty: boolean;
  related: { slug: string; title: string }[];
} | null> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, wikiSlug);
  if (!wiki) return null; // 멤버 아니면 접근 불가(테넌트 격리)
  const doc = kind === "page" ? await getPage(wiki.id, slug) : await getSource(wiki.id, slug);
  if (!doc) return null;
  const body = doc.body ?? "";
  const empty = body.trim() === "";
  let html = "";
  if (!empty) {
    const existing = await existingSlugSet(wiki.id);
    html = await renderMarkdown(body, {
      hrefFor: (t) => `/wikis/${wikiSlug}/${t}`,
      exists: (t) => existing.has(t),
    });
  }

  // 관련 문서: page는 아웃링크+백링크, source는 이 원문에서 파생된 페이지
  let related: { slug: string; title: string }[] = [];
  if (kind === "page") {
    const [out, back] = await Promise.all([getOutlinks(wiki.id, doc.id), getBacklinks(wiki.id, doc.id)]);
    const seen = new Set<string>([slug]);
    for (const r of [...out, ...back]) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      related.push(r);
    }
  } else {
    related = await prisma.page.findMany({
      where: { wikiId: wiki.id, sourceId: doc.id },
      select: { slug: true, title: true },
    });
  }

  return {
    title: doc.title,
    html,
    url: kind === "source" ? ((doc as { url?: string | null }).url ?? null) : null,
    empty,
    related,
  };
}

/** 채팅 답변을 answer 페이지로 저장(탐색 축적). editor 이상. */
export async function saveAnswerAction(slug: string, question: string, answer: string): Promise<{ slug: string }> {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) throw new Error("접근 권한이 없습니다");
  if (!hasRole(wiki.role, "editor")) throw new Error("쓰기 권한이 없습니다(editor 이상)");
  const title = (question.trim() || "채팅 답변").slice(0, 80);
  const res = await upsertPage(wiki.id, { title, kind: "answer", body: `# ${title}\n\n${answer.trim()}\n` });
  await prisma.logEntry.create({ data: { wikiId: wiki.id, kind: "query", title: `chat | ${title}`, detail: res.slug } });
  return { slug: res.slug };
}
