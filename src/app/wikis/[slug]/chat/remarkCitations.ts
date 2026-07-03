import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";

// [1] 또는 [1, 2, 3] (Gemini가 쉼표 다중 인용도 출력). 표기는 유지하고 숫자만 링크로.
const CITE = /\[(\d+(?:,\s*\d+)*)\]/g;

/**
 * 답변 본문의 [n]·[n, m] 인용을 링크 노드(#cite-N)로 변환.
 * markdown.ts의 remarkWikiLink와 동일 패턴 — text 노드만 방문하므로 코드블록·인라인코드 자동 제외.
 * 렌더 측(components.a 오버라이드)이 #cite-N 링크를 근거 열기 버튼으로 바꾼다.
 */
export function remarkCitations() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      const value = node.value;
      if (!value.includes("[")) return;

      const children: unknown[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      CITE.lastIndex = 0;
      while ((m = CITE.exec(value))) {
        if (m.index > last) children.push({ type: "text", value: value.slice(last, m.index) });
        // "[1, 2, 3]" → "[" link(1) ", " link(2) ", " link(3) "]" — 원문 표기 유지, 숫자만 클릭
        children.push({ type: "text", value: "[" });
        const nums = m[1].split(",").map((s) => s.trim());
        nums.forEach((n, j) => {
          if (j > 0) children.push({ type: "text", value: ", " });
          children.push({
            type: "link",
            url: `#cite-${n}`,
            data: { hProperties: { className: "cite-ref" } },
            children: [{ type: "text", value: n }],
          });
        });
        children.push({ type: "text", value: "]" });
        last = m.index + m[0].length;
      }
      if (last < value.length) children.push({ type: "text", value: value.slice(last) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (children.length) (parent as any).children.splice(index, 1, ...(children as any));
    });
  };
}
