"use server";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser, getPage, deletePage, upsertPage } from "@/lib/wiki";
import { hasRole } from "@/lib/api-gate";
import { mergeCategory, renameCategory, retireCategory, setPageCategory } from "@/lib/governance";

// lint 페이지 category 거버넌스 액션. editor 이상만.
async function gate(slug: string) {
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki || !hasRole(wiki.role, "editor")) throw new Error("권한 없음(editor 이상 필요)");
  return wiki;
}

// 정크 노트(출처 없는 note) 삭제. 1a DELETE 가드와 동일한 안전 재검증을 서버측에서 한 번 더.
export async function deleteJunkNoteAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const pageSlug = String(formData.get("pageSlug") ?? "");
  const page = await getPage(wiki.id, pageSlug);
  if (page && page.kind === "note" && page.sourceId == null) {
    await deletePage(wiki.id, page.slug);
  }
  revalidatePath(`/wikis/${slug}/lint`);
}

// 페이지 pageSlug의 "## 관련 문서" 섹션에 [[linkSlugs]]를 추가한다. 이미 링크된 건 제외.
// 파생 페이지만 대상(note·meta 보호). provenance(sourceId)·category는 upsertPage undefined=미변경으로 보존.
async function appendRelatedLinks(wikiId: string, pageSlug: string, linkSlugs: string[]): Promise<void> {
  const page = await getPage(wikiId, pageSlug);
  if (!page || page.kind === "note" || page.kind === "meta") return;
  const fresh = linkSlugs.filter((t) => t && t !== pageSlug && !page.body.includes(`[[${t}]]`) && !page.body.includes(`[[${t}|`));
  if (!fresh.length) return;
  const linksMd = fresh.map((t) => `- [[${t}]]`).join("\n");
  // 헤딩 변형(##/### · 공백 유무 · 뒤 텍스트) 허용. 치환 문자열이 아니라 replacer 함수를 써서
  // linkSlugs 안의 `$` 시퀀스가 치환 패턴으로 해석되어 본문을 오염시키는 것을 막는다.
  const hasSection = /^#{2,3}\s*관련\s*문서.*$/m.test(page.body);
  const body = hasSection
    ? page.body.replace(/^(#{2,3}\s*관련\s*문서.*)$/m, (_m, g1) => `${g1}\n${linksMd}`)
    : `${page.body.trimEnd()}\n\n## 관련 문서\n${linksMd}\n`;
  await upsertPage(wikiId, {
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    body,
    category: page.category ?? undefined,
    expectedVersion: page.currentVersion,
  });
}

// 고립 파생 페이지의 링크 제안 적용(방향 인식). outbound 부족이면 P→후보로, inbound 부족이면 후보→P로
// [[링크]]를 추가해 실제로 고립을 해소한다. 둘 다 부족하면 양방향 모두.
export async function applyLinkSuggestionAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const pageSlug = String(formData.get("pageSlug") ?? "");
  const parse = (k: string) =>
    String(formData.get(k) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const needs = parse("needs");
  const targets = parse("targets");
  if (targets.length) {
    if (needs.includes("outbound")) await appendRelatedLinks(wiki.id, pageSlug, targets); // P → 후보
    if (needs.includes("inbound")) for (const t of targets) await appendRelatedLinks(wiki.id, t, [pageSlug]); // 후보 → P
  }
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function mergeCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  await mergeCategory(wiki.id, String(formData.get("from") ?? ""), String(formData.get("into") ?? ""));
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function renameCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  await renameCategory(wiki.id, String(formData.get("from") ?? ""), String(formData.get("to") ?? ""));
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function retireCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const reassign = String(formData.get("reassignTo") ?? "").trim();
  await retireCategory(wiki.id, String(formData.get("slug") ?? ""), reassign || null);
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function flattenCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const from = String(formData.get("slug") ?? "");
  const parent = from.split("/").slice(0, -1).join("/"); // 한 단계 상위 경로
  if (!parent) throw new Error("최상위 category는 평탄화할 수 없습니다");
  await renameCategory(wiki.id, from, parent); // 부모가 이미 있으면 renameCategory가 mergeCategory로 위임(흡수)
  revalidatePath(`/wikis/${slug}/lint`);
}

export async function assignCategoryAction(formData: FormData) {
  const slug = String(formData.get("wikiSlug") ?? "");
  const wiki = await gate(slug);
  const category = String(formData.get("category") ?? "").trim();
  await setPageCategory(wiki.id, String(formData.get("pageSlug") ?? ""), category || null);
  revalidatePath(`/wikis/${slug}/lint`);
}
