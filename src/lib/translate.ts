import "server-only";
import { createHash } from "node:crypto";
import { generateText, llmEnabledForModel } from "@/lib/gemini";
import { genModel } from "@/lib/model-config";
import {
  EXTERNAL_MODEL_SCOPE,
  getModelPageById,
  withExternalModelDispatchLock,
} from "@/lib/model-access";
import type { LangCode } from "@/lib/lang";

const LANG_NAME: Record<LangCode, string> = { ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese" };

/** 번역 캐시 무효화 기준: 원문(title+body) 해시. 원문이 바뀌면 값이 달라져 재번역된다. */
export function pageContentHash(title: string, body: string): string {
  return createHash("sha256").update(`${title}\u0000${body}`).digest("hex").slice(0, 32);
}

// 제목과 본문을 한 번의 호출로 번역하기 위한 필드 구분자(내용에 나타날 일이 없는 토큰).
const FIELD_SEP = "⟦⟦FIELD⟧⟧";

// 위키 구조(마크다운·코드·URL·[[slug]] 링크 타깃)를 보존하도록 강하게 지시.
// 제목+본문을 한 번에 번역 — 짧은 제목을 단독으로 주면 모델이 문서를 환각 생성하므로 반드시 본문과 함께 문맥을 준다.
function translateSystem(langName: string): string {
  return (
    `You are a professional translator for a knowledge wiki. Translate the input into ${langName}.\n` +
    `The input is a TITLE line, then a line containing exactly ${FIELD_SEP}, then the BODY (Markdown).\n` +
    `Output the translated title, then a line containing exactly ${FIELD_SEP}, then the translated body. Keep that separator line verbatim.\n` +
    `STRICT RULES:\n` +
    `- Translate ONLY. Never add, remove, summarize, or invent content. The title is a short heading — translate it as a phrase, do NOT expand it into an article.\n` +
    `- Preserve all Markdown structure exactly (headings, lists, tables, blockquotes, "> [!warning]" callouts).\n` +
    `- Do NOT translate content inside inline code, code blocks, URLs, or HTML tags.\n` +
    `- Wiki links are written as [[slug]] or [[slug|label]]. Keep the target slug EXACTLY as-is; translate only the label after "|" when present. Never alter a [[...]] target.\n` +
    `- Keep numbers, proper nouns, and citation markers like [1] intact.\n` +
    `- Output ONLY the translated title, the ${FIELD_SEP} separator, and the translated body — no preamble, no code fences.`
  );
}

export interface PageTranslationResult {
  title: string;
  body: string;
  cached: boolean;
}

/**
 * 페이지를 대상 언어로 번역(캐시 우선). (page, locale)당 1행을 유지하고 원문 해시로 stale을 판정한다.
 * 캐시 히트면 LLM 호출 없이 즉시 반환. 미스/stale이면 번역 후 upsert.
 * 호출부(page.tsx)가 locale === 원문 언어인 경우를 걸러 불필요한 번역을 막는다.
 */
export async function getPageTranslation(
  pageInput: { id: string; title: string; body: string },
  locale: LangCode,
  meta: { wikiId: string; userId?: string | null },
): Promise<PageTranslationResult> {
  // single-flight: 같은 (pageId,locale)에 대한 콜드캐시 요청이 동시에 오면 LLM 호출을 1회로 합친다.
  const key = `${pageInput.id}:${locale}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = withExternalModelDispatchLock(meta.wikiId, async (tx): Promise<PageTranslationResult> => {
    // 호출자가 넘긴 raw content를 신뢰하지 않는다. cache hit 반환부터 dispatch/cache write까지
    // 동일 shared-lock transaction에서 현재 projection만 사용한다.
    const currentPage = await getModelPageById(meta.wikiId, pageInput.id, EXTERNAL_MODEL_SCOPE);
    if (!currentPage) throw new Error("외부 AI 처리가 허용되지 않은 페이지입니다");
    const currentHash = pageContentHash(currentPage.title, currentPage.body);
    const existing = await tx.pageTranslation.findUnique({
      where: { pageId_locale: { pageId: currentPage.id, locale } },
    });
    if (existing && existing.sourceHash === currentHash) {
      return { title: existing.title, body: existing.body, cached: true };
    }
    if (!llmEnabledForModel(genModel())) {
      throw new Error("LLM provider 미설정 — 번역에는 LLM(키/OAuth)이 필요합니다");
    }

    const system = translateSystem(LANG_NAME[locale]);
    const usageMeta = { userId: meta.userId ?? null, apiKeyId: null, wikiId: meta.wikiId, route: "translate" };
    const raw = await generateText(
      system,
      `${currentPage.title}\n${FIELD_SEP}\n${currentPage.body}`,
      usageMeta,
    );

    const sepIdx = raw.indexOf(FIELD_SEP);
    let translatedTitle: string;
    let translatedBody: string;
    if (sepIdx >= 0) {
      translatedTitle = raw.slice(0, sepIdx).trim();
      translatedBody = raw.slice(sepIdx + FIELD_SEP.length).trim();
    } else {
      // 구분자 유실 → 제목은 원문 유지(환각 title 오염 방지), 출력 전체를 본문으로 취급.
      translatedTitle = currentPage.title;
      translatedBody = raw.trim();
    }
    // 원문이 비어있지 않은데 번역 본문이 빈 값이면(안전거부·truncation·오류) 캐시하지 않는다.
    // 빈 본문을 upsert하면 sourceHash가 동일해 blank가 영구 고착되고 재시도되지 않는다 → throw로 재시도 유도.
    if (currentPage.body.trim() && !translatedBody) {
      throw new Error("번역 본문이 비어 있음 — 캐시 생략(재시도 유도)");
    }
    const result = { title: translatedTitle || currentPage.title, body: translatedBody };

    try {
      await tx.pageTranslation.upsert({
        where: { pageId_locale: { pageId: currentPage.id, locale } },
        create: { pageId: currentPage.id, locale, sourceHash: currentHash, title: result.title, body: result.body },
        update: { sourceHash: currentHash, title: result.title, body: result.body },
      });
    } catch (e) {
      // 교차 프로세스 경쟁: 다른 인스턴스가 먼저 같은 행을 만들었을 수 있음(P2002). 값은 동일하므로 무시.
      if ((e as { code?: string })?.code !== "P2002") throw e;
    }
    return { ...result, cached: false };
  });

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

// 진행 중 번역 작업(프로세스 로컬). 동시 콜드캐시 요청의 중복 LLM 호출을 막는다.
const inflight = new Map<string, Promise<PageTranslationResult>>();
