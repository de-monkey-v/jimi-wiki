import assert from "node:assert/strict";
import test from "node:test";
import {
  categoryTocSlugOrder,
  compareFolderPages,
  resolveFolderSortMode,
  sortFolderSubtreePages,
  type FolderSortablePage,
} from "./folder-sort";
import type { TocSection } from "./kinds";

const at = (value: string) => new Date(`${value}T00:00:00.000Z`);
const page = (
  slug: string,
  title: string,
  category: string,
  createdAt: string,
  options: { kind?: string; documentAt?: string | null } = {},
): FolderSortablePage => ({
  slug,
  title,
  category,
  kind: options.kind ?? "concept",
  documentAt: options.documentAt ? at(options.documentAt) : null,
  createdAt: at(createdAt),
});

test("Auto는 정확·하위 document가 있으면 newest, 없으면 title이다", () => {
  const pages = [
    page("parent-concept", "나", "ai", "2026-08-08"),
    page("nested-document", "가", "ai/trends", "2026-08-09", { kind: "document", documentAt: "2026-08-10" }),
    page("prefix-document", "다", "aix", "2026-08-11", { kind: "document" }),
  ];
  assert.equal(resolveFolderSortMode(null, pages, "ai"), "newest");
  assert.equal(resolveFolderSortMode(null, pages, "a"), "title", "문자열 prefix만 겹치는 형제는 하위가 아니다");
  assert.equal(resolveFolderSortMode(null, pages.filter((item) => item.kind !== "document"), "ai"), "title");
  assert.equal(resolveFolderSortMode("oldest", pages, "ai"), "oldest", "명시 설정은 Auto보다 우선한다");
});

test("newest/oldest는 documentAt을 우선하고 없으면 createdAt을 쓰며 제목 날짜를 파싱하지 않는다", () => {
  const semanticOld = page("semantic-old", "2099-12-31", "ai", "2026-08-12", {
    kind: "document",
    documentAt: "2026-08-09",
  });
  const fallbackNew = page("fallback-new", "1900-01-01", "ai", "2026-08-10");
  assert.equal(compareFolderPages(semanticOld, fallbackNew, "newest") > 0, true);
  assert.deepEqual(
    [semanticOld, fallbackNew].sort((a, b) => compareFolderPages(a, b, "newest")).map((item) => item.slug),
    ["fallback-new", "semantic-old"],
  );
  assert.deepEqual(
    [semanticOld, fallbackNew].sort((a, b) => compareFolderPages(a, b, "oldest")).map((item) => item.slug),
    ["semantic-old", "fallback-new"],
  );
});

test("동일 시각과 이름순은 title 다음 slug 오름차순으로 결정된다", () => {
  const pages = [
    page("z-slug", "Zulu", "ai", "2026-08-10"),
    page("a-slug", "Zulu", "ai", "2026-08-10"),
    page("middle", "Alpha", "ai", "2026-08-10"),
  ];
  assert.deepEqual(
    [...pages].sort((a, b) => compareFolderPages(a, b, "newest")).map((item) => item.slug),
    ["middle", "a-slug", "z-slug"],
  );
  assert.deepEqual(
    [...pages].sort((a, b) => compareFolderPages(a, b, "title")).map((item) => item.slug),
    ["middle", "a-slug", "z-slug"],
  );
});

test("재귀 순서는 하위 폴더 이름순을 직접 페이지보다 앞세우고 각 폴더 mode를 독립 적용한다", () => {
  const pages = [
    page("direct-new", "직접 최신", "ai", "2026-08-10"),
    page("direct-old", "직접 과거", "ai", "2026-08-08"),
    page("b-old", "가", "ai/b", "2026-08-08"),
    page("b-new", "나", "ai/b", "2026-08-10"),
    page("a-z", "하", "ai/a", "2026-08-09"),
    page("a-a", "가", "ai/a", "2026-08-09"),
  ];
  const preferences = new Map([
    ["ai", "oldest" as const],
    ["ai/a", "title" as const],
    ["ai/b", "newest" as const],
  ]);
  assert.deepEqual(
    sortFolderSubtreePages(pages, "ai", preferences).map((item) => item.slug),
    ["a-a", "a-z", "b-new", "b-old", "direct-old", "direct-new"],
  );
});

test("category 페이지용 TOC flatten은 sidebar section/재귀 순서를 보존한다", () => {
  const leaf = (slug: string) => ({
    type: "page" as const,
    slug,
    title: slug,
    kind: "document" as const,
    category: "ai",
    currentVersion: 1,
    movable: true,
    trashable: true,
  });
  const sections: TocSection[] = [
    { key: "personal", entries: [{ type: "folder", name: "ai", path: "ai", children: [leaf("personal")] }] },
    {
      key: "documents",
      entries: [{
        type: "folder",
        name: "ai",
        path: "ai",
        children: [{ type: "folder", name: "child", path: "ai/child", children: [leaf("nested")] }, leaf("direct")],
      }],
    },
    { key: "knowledge", entries: [{ type: "folder", name: "ai", path: "ai", children: [leaf("knowledge")] }] },
  ];
  assert.deepEqual(categoryTocSlugOrder(sections, "ai"), ["nested", "direct", "knowledge", "personal"]);
});
