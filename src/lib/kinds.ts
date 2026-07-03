// 클라이언트/서버 공용(server-only 없음). 페이지 kind 라벨 + TOC 트리 타입.
import type { PageKind } from "@/generated/prisma/client";

export const KIND_LABEL: Record<PageKind, string> = {
  note: "소스 노트",
  concept: "개념",
  entity: "개체",
  answer: "답변",
  meta: "메타",
};

// 모든 유효한 page kind(닫힌 집합). REST/ingest 경로의 kind 검증·강등에 사용.
export const PAGE_KINDS: PageKind[] = ["note", "concept", "entity", "answer", "meta"];

// 사람이 수동으로 만들거나 바꿀 수 있는 kind. note는 ingest, answer는 채팅 저장, meta는 온톨로지 전용이라 제외.
export const MANUAL_KINDS: PageKind[] = ["concept", "entity"];

// 수동 생성/편집 폼의 kind 선택지(설명 라벨 포함). 생성 폼과 편집 폼이 이 목록을 공유한다.
export const MANUAL_KIND_OPTIONS: { value: PageKind; label: string }[] = [
  { value: "concept", label: "개념 — 아이디어·패턴·이론·문서" },
  { value: "entity", label: "개체 — 인물·조직·도구·제품" },
];

export interface TocNode {
  slug: string;
  title: string;
  kind: PageKind;
  children: TocNode[];
}

/** kind(카테고리)별 섹션 + 그 안의 페이지 트리. */
export interface TocGroup {
  kind: PageKind;
  label: string;
  nodes: TocNode[];
}

/** 사이드바/목록에 노출하는 kind 순서. */
export const KIND_ORDER: PageKind[] = ["note", "concept", "entity", "answer", "meta"];

// ---------- P2: 탐색기(VSCode식) 폴더 트리 ----------
export type TocLeaf = { type: "page"; slug: string; title: string; kind: PageKind };
export type TocFolder = { type: "folder"; name: string; path: string; children: TocEntry[] };
export type TocEntry = TocLeaf | TocFolder;
/** 2섹션: 원문/소스(note) vs 정리된 지식(파생, category 폴더 트리). */
export interface TocSection {
  key: "sources" | "knowledge";
  label: string;
  entries: TocEntry[];
}

// ---------- P3: 그래프 뷰 ----------
export interface GraphNode {
  slug: string;
  title: string;
  kind: PageKind | null; // broken(ghost) 노드는 null
  category: string | null;
  degree: number;
  broken?: boolean; // 아직 페이지 없는 위키링크 대상
}
export interface GraphEdge {
  source: string;
  target: string;
}
export interface WikiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** kind별 노드 색(globals.css 뉴트럴+indigo 팔레트와 정합). */
export const KIND_COLOR: Record<PageKind, string> = {
  note: "#78716c", // stone-500 (원문 성격)
  concept: "#4f46e5", // indigo accent
  entity: "#0d9488", // teal
  answer: "#059669", // emerald
  meta: "#a8a29e", // stone-400
};
export const BROKEN_COLOR = "#dc2626"; // red — 깨진 링크 노드
export function nodeColor(n: { kind: PageKind | null; broken?: boolean }): string {
  return n.broken || !n.kind ? BROKEN_COLOR : KIND_COLOR[n.kind];
}
