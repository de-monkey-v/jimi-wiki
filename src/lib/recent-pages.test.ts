import assert from "node:assert/strict";
import test from "node:test";
import { addRecentPage, parseRecentPages, recentKey } from "./recent-pages";

test("recent pages v2는 문서·개념·개체만 복원하고 손상된 항목을 버린다", () => {
  const parsed = parseRecentPages(JSON.stringify([
    { slug: "doc", title: "문서", kind: "document" },
    { slug: "source-note", title: "원문", kind: "note" },
    { slug: "concept", title: "개념", kind: "concept" },
    null,
  ]));
  assert.deepEqual(parsed, [
    { slug: "doc", title: "문서", kind: "document" },
    { slug: "concept", title: "개념", kind: "concept" },
  ]);
  assert.deepEqual(parseRecentPages("{broken"), []);
});

test("recent pages는 재방문 항목을 맨 앞으로 옮기고 8개로 제한한다", () => {
  const initial = Array.from({ length: 8 }, (_, index) => ({
    slug: `page-${index}`,
    title: `Page ${index}`,
    kind: "document" as const,
  }));
  const revisited = addRecentPage(initial, { slug: "page-5", title: "Updated", kind: "document" });
  assert.equal(revisited.length, 8);
  assert.deepEqual(revisited[0], { slug: "page-5", title: "Updated", kind: "document" });
  assert.equal(revisited.filter((item) => item.slug === "page-5").length, 1);

  const added = addRecentPage(initial, { slug: "new", title: "New", kind: "entity" });
  assert.equal(added.length, 8);
  assert.equal(added[0]?.slug, "new");
  assert.equal(added.some((item) => item.slug === "page-7"), false);
});

test("recent pages는 기존 v1 키와 분리된다", () => {
  assert.equal(recentKey("personal"), "jimi:recent:v2:personal");
});
