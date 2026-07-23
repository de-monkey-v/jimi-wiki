import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { visit, SKIP } from "unist-util-visit";
import type { Root, Text } from "mdast";

// 기본 스키마(href/src를 http/https/mailto/상대경로로 제한, javascript: 차단) + 위키링크 className 허용
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // 기본 스키마의 className 정의(a에 대해 값 "data-footnote-backref"만 허용)에 위키링크 값을 병합.
    // append로는 findDefinition이 기본 정의를 먼저 반환해 무시되므로 map으로 기존 정의에 값을 더한다.
    a: (defaultSchema.attributes?.a ?? []).map((e) =>
      Array.isArray(e) && e[0] === "className" ? ([...e, "wikilink", "wikilink-missing"] as typeof e) : e,
    ),
  },
};

const WIKILINK = /\[\[([^\]]+?)\]\]/g;

// CommonMark가 [[slug]](gloss)를 먼저 링크로 삼킨 경우의 시그니처:
// link 노드의 유일한 text 자식이 정확히 "[inner]"(단일 대괄호) 형태다.
// 정상 마크다운 [text](url)의 링크 텍스트에는 대괄호가 없으므로 오탐이 사실상 없다.
const LINK_COLLISION = /^\[([^[\]]+)\]$/;

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
export function remarkWikiLink(opts: {
  hrefFor: (target: string) => string;
  exists?: (target: string) => boolean;
}) {
  // 위키링크 링크 노드 빌더 — 두 패스가 공유하므로 className/href/exists 의미가 갈라지지 않는다.
  const makeWikiLinkNode = (inner: string) => {
    const { target, label } = parseTarget(inner);
    const missing = opts.exists ? !opts.exists(target) : false;
    return {
      type: "link",
      url: opts.hrefFor(target),
      // className은 hast 토큰 배열로 — 문자열로 주면 sanitize/stringify가 드롭한다.
      data: { hProperties: { className: missing ? ["wikilink", "wikilink-missing"] : ["wikilink"] } },
      children: [{ type: "text", value: label }],
    };
  };

  return (tree: Root, file?: unknown) => {
    const source = file ? String(file) : "";

    // 1) CommonMark가 [[slug]](gloss)를 하나의 link 노드로 먼저 삼킨 경우 복구.
    //    gloss에 내부 공백이 없어 유효한 링크 목적지가 될 때만 발생한다.
    //    link 노드의 유일한 text 자식이 "[inner]"(단일 대괄호)면 위키링크로 되돌리고,
    //    뒤따르던 (gloss)는 원문 오프셋으로 정확히 잘라 literal text로 다시 내보낸다.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visit(tree, "link", (node: any, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      if (!node.children || node.children.length !== 1) return;
      const only = node.children[0];
      if (!only || only.type !== "text") return;
      const bm = LINK_COLLISION.exec(only.value);
      if (!bm) return;
      const { target } = parseTarget(bm[1]);
      if (!target) return; // 정규화 후 빈 타깃이면 실제 위키링크가 아님

      // gloss는 원문 오프셋으로 정확히 복원(디코딩/이스케이프 왜곡 방지).
      // 슬라이스 범위 [textEnd+1, linkEnd)는 이미 양쪽 괄호를 포함한다.
      // 위치 정보가 없을 때만 디코딩된 url로 폴백.
      let gloss = `(${node.url})`;
      const tEnd = only.position?.end?.offset;
      const lEnd = node.position?.end?.offset;
      if (source && typeof tEnd === "number" && typeof lEnd === "number") {
        gloss = source.slice(tEnd + 1, lEnd);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).children.splice(index, 1, makeWikiLinkNode(bm[1]), {
        type: "text",
        value: gloss,
      });
      return [SKIP, index + 2]; // 삽입한 두 노드를 재방문하지 않음
    });

    // 2) CommonMark가 건드리지 않은 text 노드의 [[..]] 처리(공백 gloss·bare·label·다중 포함).
    //    text 노드만 방문하므로 코드블록·인라인코드는 자동 제외된다.
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
        children.push(makeWikiLinkNode(m[1]));
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
  // [[x]](무공백gloss)는 CommonMark가 link 노드(text 자식 "[inner]")로 먼저 삼킨다 — 렌더 경로와 동일.
  // 이 케이스도 타깃을 뽑아야 PageLink/그래프 엣지가 누락되지 않는다.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit(tree, "link", (node: any) => {
    if (node.children?.length !== 1 || node.children[0].type !== "text") return;
    const bm = LINK_COLLISION.exec(node.children[0].value);
    if (!bm) return;
    const { target } = parseTarget(bm[1]);
    if (target) targets.add(target);
  });
  // 살아남은 text 노드의 [[..]] (bare·label·공백gloss·다중). text 노드만 방문하므로 코드 영역 제외.
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
