"use client";

import { createMermaidPlugin } from "@streamdown/mermaid";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useTransition } from "react";
import { defaultRemarkPlugins, Streamdown, type MermaidErrorComponentProps } from "streamdown";
import type { PluggableList } from "unified";
import { createFromWikilinkAction } from "@/app/wikis/actions";
import { remarkWikiLink } from "@/lib/markdown";
import {
  guardResearchMermaid,
  remarkResearchCallouts,
  remarkResearchCitations,
  remarkResearchHeadingIds,
  safeResearchUrl,
} from "@/lib/research-markdown";

const mermaidPlugin = createMermaidPlugin({
  config: {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    suppressErrorRendering: true,
  },
});

function MermaidFallback({ chart, error }: MermaidErrorComponentProps) {
  const t = useTranslations("ResearchArticle");
  return (
    <figure className="research-mermaid-fallback" role="group" aria-label={t("diagramError")}>
      <figcaption>{t("diagramError")}</figcaption>
      <pre><code>{chart}</code></pre>
      <span className="sr-only">{error}</span>
    </figure>
  );
}

const targetOf = (anchor: HTMLAnchorElement) =>
  decodeURIComponent((anchor.getAttribute("href") ?? "").split("/").pop() ?? "");

export function ResearchMarkdown({
  body,
  sourceSlugs,
  wikiSlug,
  category,
  existingSlugs,
  canCreate,
}: {
  body: string;
  sourceSlugs: string[];
  wikiSlug: string;
  category: string | null;
  existingSlugs: string[];
  canCreate: boolean;
}) {
  const t = useTranslations("ResearchArticle");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);
  const existing = useMemo(() => new Set(existingSlugs), [existingSlugs]);
  const guarded = useMemo(() => guardResearchMermaid(body).body, [body]);
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      ...Object.values(defaultRemarkPlugins),
      [remarkWikiLink, {
        hrefFor: (target: string) => `/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(target)}`,
        exists: (target: string) => existing.has(target),
      }],
      remarkResearchHeadingIds,
      remarkResearchCallouts,
      [remarkResearchCitations, sourceSlugs],
    ],
    [existing, sourceSlugs, wikiSlug],
  );
  useEffect(() => {
    if (!root.current) return;
    const occurrences = new Map<string, number>();
    root.current.querySelectorAll<HTMLAnchorElement>('a[href^="#research-evidence-"]').forEach((anchor) => {
      const number = anchor.getAttribute("href")?.match(/^#research-evidence-(\d+)$/)?.[1];
      if (!number) return;
      const occurrence = (occurrences.get(number) ?? 0) + 1;
      occurrences.set(number, occurrence);
      anchor.id = `research-citation-${number}-${occurrence}`;
      anchor.classList.add("research-citation");
      anchor.setAttribute("aria-label", t("openEvidence", { number }));
    });
  }, [body, sourceSlugs, t]);

  const onClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.hash.startsWith("#research-evidence-")) {
      event.preventDefault();
      window.history.pushState(null, "", anchor.hash);
      document.getElementById(anchor.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!canCreate || pending || !anchor.classList.contains("wikilink-missing")) return;
    event.preventDefault();
    const target = targetOf(anchor);
    if (!target) return;
    startTransition(async () => {
      try {
        const slug = await createFromWikilinkAction(wikiSlug, target, category);
        router.push(`/wikis/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(slug)}`);
      } catch {
        // 링크는 실패해도 본문에 그대로 남아 재시도할 수 있다.
      }
    });
  };

  return (
    <div
      ref={root}
      className={`research-content wiki-content${canCreate ? " wiki-content--create" : ""}`}
      data-creating={pending ? "" : undefined}
      onClick={onClick}
    >
      <Streamdown
        mode="static"
        controls={{
          code: { copy: true, download: true },
          table: { copy: true, download: true, fullscreen: true },
          mermaid: { copy: true, download: true, fullscreen: true, panZoom: true },
        }}
        lineNumbers={false}
        plugins={{ mermaid: mermaidPlugin }}
        mermaid={{
          config: {
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
            suppressErrorRendering: true,
          },
          errorComponent: MermaidFallback,
        }}
        components={{
          a: ({ href, children, node, ...props }) => {
            void node;
            const safe = typeof href === "string" ? safeResearchUrl(href) : "";
            if (!safe) return <span>{children}</span>;
            const internal = safe.startsWith("#") || safe.startsWith("/") || safe.startsWith("./") || safe.startsWith("../");
            return (
              <a
                {...props}
                href={safe}
                target={internal ? undefined : "_blank"}
                rel={internal ? undefined : "noopener noreferrer"}
              >
                {children}
              </a>
            );
          },
        }}
        allowedTags={{
          a: ["ariaLabel", "href", "className"],
          blockquote: ["className", "dataCallout"],
        }}
        remarkPlugins={remarkPlugins}
        skipHtml
        urlTransform={(url) => safeResearchUrl(url) || null}
        translations={{
          copyCode: t("copy"),
          downloadFile: t("download"),
          downloadDiagram: t("downloadDiagram"),
          viewFullscreen: t("fullscreen"),
          exitFullscreen: t("exitFullscreen"),
          copyTable: t("copyTable"),
          downloadTable: t("downloadTable"),
        }}
      >
        {guarded}
      </Streamdown>
    </div>
  );
}
