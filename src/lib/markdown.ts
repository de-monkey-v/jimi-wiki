import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";

// 기본 스키마(href/src를 http/https/mailto/상대경로로 제한, javascript: 차단) + 위키링크 className 허용
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "className"],
  },
};

const WIKILINK = /\[\[([^\]]+?)\]\]/g;

/** 위키링크 타깃/페이지 슬러그 정규화 (한글 허용) */
export function normalizeSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
}

function parseTarget(raw: string): { target: string; label: string } {
  const [t, l] = raw.split("|");
  return { target: normalizeSlug(t), label: (l ?? t).trim() };
}

/** [[target]] / [[target|label]] 를 링크 노드로. text 노드만 방문하므로 코드블록·인라인코드는 자동 제외 */
function remarkWikiLink(opts: {
  hrefFor: (target: string) => string;
  exists?: (target: string) => boolean;
}) {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      const value = node.value;
      if (!value.includes("[[")) return;

      const children: unknown[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      WIKILINK.lastIndex = 0;
      while ((m = WIKILINK.exec(value))) {
        if (m.index > last) children.push({ type: "text", value: value.slice(last, m.index) });
        const { target, label } = parseTarget(m[1]);
        const missing = opts.exists ? !opts.exists(target) : false;
        children.push({
          type: "link",
          url: opts.hrefFor(target),
          data: { hProperties: { className: missing ? "wikilink wikilink-missing" : "wikilink" } },
          children: [{ type: "text", value: label }],
        });
        last = m.index + m[0].length;
      }
      if (last < value.length) children.push({ type: "text", value: value.slice(last) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (children.length) (parent as any).children.splice(index, 1, ...(children as any));
    });
  };
}

/** 본문에서 위키링크 타깃 슬러그를 추출(PageLink 재계산용). 코드 영역 제외 */
export function extractWikiTargets(body: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as Root;
  const targets = new Set<string>();
  visit(tree, "text", (node: Text) => {
    let m: RegExpExecArray | null;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(node.value))) {
      const { target } = parseTarget(m[1]);
      if (target) targets.add(target);
    }
  });
  return [...targets];
}

export async function renderMarkdown(
  body: string,
  o: { hrefFor: (t: string) => string; exists?: (t: string) => boolean },
): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWikiLink, o)
    .use(remarkRehype)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeSlug)
    .use(rehypeStringify)
    .process(body);
  return String(file);
}
