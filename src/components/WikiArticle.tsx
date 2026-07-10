"use client";
import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createFromWikilinkAction } from "@/app/wikis/actions";

const targetOf = (a: HTMLAnchorElement) => decodeURIComponent((a.getAttribute("href") ?? "").split("/").pop() ?? "");

/**
 * 위키 본문 렌더러(클라이언트). create가 있으면 미해결 [[link]](a.wikilink-missing) 클릭을 가로채
 * 그 slug로 페이지를 생성하고 이동한다(Obsidian식). 발견성을 위해 create 모드에서만 툴팁·호버 큐를 붙인다.
 * create 없으면(공개/뷰어) 일반 아티클과 동일 — 미해결 링크는 그냥 깨진(빨강) 링크.
 */
export function WikiArticle({ html, create }: { html: string; create?: { wikiSlug: string; category: string | null } }) {
  const t = useTranslations("WikiArticle");
  const router = useRouter();
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

  return (
    <article
      ref={ref}
      className={create ? "wiki-content wiki-content--create" : "wiki-content"}
      data-creating={pending ? "" : undefined}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
