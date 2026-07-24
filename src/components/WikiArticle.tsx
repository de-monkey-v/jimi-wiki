"use client";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createFromWikilinkAction } from "@/app/wikis/actions";
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { useHoverPreview } from "@/components/ui/HoverPreview";

const targetOf = (a: HTMLAnchorElement) => decodeURIComponent((a.getAttribute("href") ?? "").split("/").pop() ?? "");

// 주입된 HTML(dangerouslySetInnerHTML) 안의 위키링크에는 React 핸들러를 못 붙이므로
// 안정된 래퍼(article)에서 위임으로 잡는다. 미해결 링크는 미리보기 대상이 아님.
const previewAnchorFrom = (target: EventTarget | null) =>
  (target instanceof Element ? target.closest("a.wikilink:not(.wikilink-missing)") : null) as HTMLAnchorElement | null;

/**
 * 위키 본문 렌더러(클라이언트). create가 있으면 미해결 [[link]](a.wikilink-missing) 클릭을 가로채
 * 그 slug로 페이지를 생성하고 이동한다(Obsidian식). 발견성을 위해 create 모드에서만 툴팁·호버 큐를 붙인다.
 * create 없으면(공개/뷰어) 일반 아티클과 동일 — 미해결 링크는 그냥 깨진(빨강) 링크.
 * HoverPreviewProvider 안에서는 존재하는 위키링크 hover/focus에 미리보기 카드가 붙는다(밖에서는 무동작).
 */
export function WikiArticle({
  html,
  create,
  selection,
}: {
  html: string;
  create?: { wikiSlug: string; category: string | null };
  selection?: { pageSlug: string; canWrite: boolean }; // 있으면 텍스트 선택 툴바 활성(비공개 뷰)
}) {
  const t = useTranslations("WikiArticle");
  const router = useRouter();
  const preview = useHoverPreview();
  const [pending, start] = useTransition();
  const ref = useRef<HTMLElement>(null);

  // create 모드: 각 미해결 링크에 "클릭하면 만들기" 툴팁(title) 부여 → 기능 발견성.
  useEffect(() => {
    if (!create || !ref.current) return;
    ref.current.querySelectorAll<HTMLAnchorElement>("a.wikilink-missing").forEach((a) => {
      const slug = targetOf(a);
      if (slug) a.title = t("createHint", { slug });
    });
  }, [create, html, t]);

  const onClick = (e: React.MouseEvent) => {
    if (!create || pending) return;
    const a = (e.target as HTMLElement).closest("a.wikilink-missing") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const target = targetOf(a);
    if (!target) return;
    start(async () => {
      try {
        const slug = await createFromWikilinkAction(create.wikiSlug, target, create.category);
        router.push(`/wikis/${encodeURIComponent(create.wikiSlug)}/${encodeURIComponent(slug)}`);
      } catch {
        /* 무시 — 링크는 그대로 남는다 */
      }
    });
  };

  const onPreviewOver = (e: React.SyntheticEvent) => {
    if (!preview) return;
    const a = previewAnchorFrom(e.target);
    if (!a) return;
    const slug = targetOf(a);
    if (slug) preview.show(a, slug);
  };
  const onPreviewOut = (e: React.MouseEvent) => {
    if (!preview) return;
    const a = previewAnchorFrom(e.target);
    if (a && !(e.relatedTarget instanceof Node && a.contains(e.relatedTarget))) preview.hide();
  };
  const onPreviewBlur = (e: React.FocusEvent) => {
    if (!preview) return;
    if (previewAnchorFrom(e.target)) preview.hide();
  };

  return (
    <>
      <article
        ref={ref}
        className={create ? "wiki-content wiki-content--create" : "wiki-content"}
        data-creating={pending ? "" : undefined}
        onClick={onClick}
        onMouseOver={onPreviewOver}
        onMouseOut={onPreviewOut}
        onFocus={onPreviewOver}
        onBlur={onPreviewBlur}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {selection && <SelectionToolbar containerRef={ref} pageSlug={selection.pageSlug} canWrite={selection.canWrite} />}
    </>
  );
}
