import GithubSlugger from "github-slugger";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import type { Blockquote, Code, Heading, Paragraph, Root, Text } from "mdast";
import { normalizeSlug } from "@/lib/markdown";

export const MAX_RESEARCH_SOURCES = 30;
export const MAX_RESEARCH_MERMAID_BLOCKS = 12;
export const MAX_RESEARCH_MERMAID_BYTES = 32 * 1024;

const CITATION = /\[@([^\]\s]+)\]/g;
const CALLOUT = /^\[!(summary|info|warning)\](?:[ \t]+|$)/i;
const FORBIDDEN_MERMAID_INIT = /%%\{\s*(?:init|initialize)\s*:/i;
const FORBIDDEN_MERMAID_CLICK = /(?:^|;)\s*click(?:\s|$)/im;

type MermaidIssueCode =
  | "research_mermaid_too_many"
  | "research_mermaid_too_large"
  | "research_mermaid_config_forbidden"
  | "research_mermaid_click_forbidden";

export type ResearchMermaidIssue = {
  code: MermaidIssueCode;
  index: number;
};

export type ResearchMarkdownInspection = {
  citationSlugs: string[];
  invalidCitations: string[];
  mermaidIssues: ResearchMermaidIssue[];
};

function parse(body: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(body) as Root;
}

function mermaidIssue(code: MermaidIssueCode, index: number): ResearchMermaidIssue {
  return { code, index };
}

export function inspectResearchMarkdown(body: string): ResearchMarkdownInspection {
  const tree = parse(body);
  const citationSlugs: string[] = [];
  const invalidCitations: string[] = [];
  const seen = new Set<string>();
  visit(tree, "text", (node: Text) => {
    let match: RegExpExecArray | null;
    CITATION.lastIndex = 0;
    while ((match = CITATION.exec(node.value))) {
      const raw = match[1];
      const slug = normalizeSlug(raw);
      if (!slug || slug !== raw) {
        invalidCitations.push(raw);
        continue;
      }
      if (!seen.has(slug)) {
        seen.add(slug);
        citationSlugs.push(slug);
      }
    }
  });

  const mermaidIssues: ResearchMermaidIssue[] = [];
  let mermaidIndex = 0;
  visit(tree, "code", (node: Code) => {
    if (node.lang?.toLowerCase() !== "mermaid") return;
    mermaidIndex += 1;
    if (mermaidIndex > MAX_RESEARCH_MERMAID_BLOCKS) {
      mermaidIssues.push(mermaidIssue("research_mermaid_too_many", mermaidIndex));
    }
    if (new TextEncoder().encode(node.value).byteLength > MAX_RESEARCH_MERMAID_BYTES) {
      mermaidIssues.push(mermaidIssue("research_mermaid_too_large", mermaidIndex));
    }
    if (FORBIDDEN_MERMAID_INIT.test(node.value)) {
      mermaidIssues.push(mermaidIssue("research_mermaid_config_forbidden", mermaidIndex));
    }
    if (FORBIDDEN_MERMAID_CLICK.test(node.value)) {
      mermaidIssues.push(mermaidIssue("research_mermaid_click_forbidden", mermaidIndex));
    }
  });
  return { citationSlugs, invalidCitations, mermaidIssues };
}

/**
 * 저장 전 검증을 통과하지 못한 오래된 Mermaid 블록도 실행하지 않도록 opening fence의
 * language만 text로 바꾼다. 원문은 그대로 코드 fallback에 남는다.
 */
export function guardResearchMermaid(body: string): { body: string; issues: ResearchMermaidIssue[] } {
  const tree = parse(body);
  const replacements: { start: number; end: number; value: string }[] = [];
  const issues: ResearchMermaidIssue[] = [];
  let mermaidIndex = 0;
  visit(tree, "code", (node: Code) => {
    if (node.lang?.toLowerCase() !== "mermaid") return;
    mermaidIndex += 1;
    const blockIssues: ResearchMermaidIssue[] = [];
    if (mermaidIndex > MAX_RESEARCH_MERMAID_BLOCKS) {
      blockIssues.push(mermaidIssue("research_mermaid_too_many", mermaidIndex));
    }
    if (new TextEncoder().encode(node.value).byteLength > MAX_RESEARCH_MERMAID_BYTES) {
      blockIssues.push(mermaidIssue("research_mermaid_too_large", mermaidIndex));
    }
    if (FORBIDDEN_MERMAID_INIT.test(node.value)) {
      blockIssues.push(mermaidIssue("research_mermaid_config_forbidden", mermaidIndex));
    }
    if (FORBIDDEN_MERMAID_CLICK.test(node.value)) {
      blockIssues.push(mermaidIssue("research_mermaid_click_forbidden", mermaidIndex));
    }
    issues.push(...blockIssues);
    if (blockIssues.length === 0) return;
    const start = node.position?.start.offset;
    if (typeof start !== "number") return;
    const lineEnd = body.indexOf("\n", start);
    if (lineEnd < 0) return;
    const opening = body.slice(start, lineEnd);
    const next = opening.replace(/mermaid/i, "text");
    replacements.push({ start, end: lineEnd, value: next });
  });
  let guarded = body;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    guarded = `${guarded.slice(0, replacement.start)}${replacement.value}${guarded.slice(replacement.end)}`;
  }
  return { body: guarded, issues };
}

function quoteLeadingSlashLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Mermaid에서 노드 라벨 첫 글자의 /는 도형 문법으로 해석된다. 보고서 생성기가 흔히
 * 쓰는 경로 라벨은 인용해 일반 텍스트로 유지한다. 위험 블록은 guard 이후 text가 되어
 * 이 단계에 도달하지 않는다.
 */
export function normalizeResearchMermaid(body: string): string {
  const tree = parse(body);
  const replacements: { start: number; end: number; value: string }[] = [];
  visit(tree, "code", (node: Code) => {
    if (node.lang?.toLowerCase() !== "mermaid") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") return;
    const valueStart = body.indexOf(node.value, start);
    if (valueStart < start || valueStart >= end) return;
    const value = node.value.replace(
      /(\b[A-Za-z_][\w-]*\s*)\[\s*(\/[^\]\r\n]*)\]/g,
      (_match, nodeId: string, label: string) => `${nodeId}["${quoteLeadingSlashLabel(label)}"]`,
    );
    if (value !== node.value) replacements.push({ start: valueStart, end: valueStart + node.value.length, value });
  });
  let normalized = body;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    normalized = `${normalized.slice(0, replacement.start)}${replacement.value}${normalized.slice(replacement.end)}`;
  }
  return normalized;
}

function textContent(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { value?: unknown; children?: unknown[] };
  if (typeof value.value === "string") return value.value;
  return value.children?.map(textContent).join("") ?? "";
}

export function remarkResearchHeadingIds() {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree, "heading", (node: Heading) => {
      const id = slugger.slug(textContent(node));
      node.data = {
        ...node.data,
        hProperties: { ...(node.data?.hProperties ?? {}), id },
      };
    });
  };
}

export function remarkResearchCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const paragraph = node.children[0] as Paragraph | undefined;
      const first = paragraph?.children[0] as Text | undefined;
      if (!paragraph || first?.type !== "text") return;
      const match = CALLOUT.exec(first.value);
      if (!match) return;
      const kind = match[1].toLowerCase();
      first.value = first.value.slice(match[0].length);
      node.data = {
        ...node.data,
        hProperties: {
          ...(node.data?.hProperties ?? {}),
          className: ["research-callout", `research-callout--${kind}`],
          "data-callout": kind,
        },
      };
    });
  };
}

export function remarkResearchCitations(sourceSlugs: string[]) {
  const numberBySlug = new Map(sourceSlugs.map((slug, index) => [slug, index + 1]));
  const occurrences = new Map<string, number>();
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined || !node.value.includes("[@")) return;
      const children: unknown[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      CITATION.lastIndex = 0;
      while ((match = CITATION.exec(node.value))) {
        const slug = normalizeSlug(match[1]);
        const number = numberBySlug.get(slug);
        if (!number) continue;
        if (match.index > last) children.push({ type: "text", value: node.value.slice(last, match.index) });
        const occurrence = (occurrences.get(slug) ?? 0) + 1;
        occurrences.set(slug, occurrence);
        children.push({
          type: "link",
          url: `#research-evidence-${number}`,
          data: {
            hProperties: {
              id: `research-citation-${number}-${occurrence}`,
              className: ["research-citation"],
              "aria-label": `citation ${number}`,
            },
          },
          children: [{ type: "text", value: `[${number}]` }],
        });
        last = match.index + match[0].length;
      }
      if (children.length === 0) return;
      if (last < node.value.length) children.push({ type: "text", value: node.value.slice(last) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).children.splice(index, 1, ...(children as any));
      return [SKIP, index + children.length];
    });
  };
}

export function safeResearchUrl(url: string): string {
  const value = url.trim();
  if (value.startsWith("//") || value.startsWith("/\\")) return "";
  if (
    value.startsWith("#") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^https?:\/\//i.test(value) ||
    /^mailto:/i.test(value)
  ) {
    return value;
  }
  return "";
}
