import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalContentHash, pageSnapshotHash, sourceSnapshotHash } from "./content-hash";

test("canonical hash는 객체 key 순서와 무관하다", () => {
  assert.equal(canonicalContentHash({ b: 2, a: { y: 2, x: 1 } }), canonicalContentHash({ a: { x: 1, y: 2 }, b: 2 }));
});

test("Page hash는 전체 snapshot 정책/상태 변경을 감지한다", () => {
  const base = {
    title: "문서",
    body: "본문",
    kind: "concept",
    frontmatter: { z: 1 },
    category: null,
    parentId: null,
    sortOrder: 0,
    sourceId: null,
    origin: "human",
    modelAccess: "external",
    archivedAt: null,
    suppressedAt: null,
    staleAt: null,
  };
  assert.notEqual(pageSnapshotHash(base), pageSnapshotHash({ ...base, modelAccess: "internalOnly" }));
  assert.notEqual(pageSnapshotHash(base), pageSnapshotHash({ ...base, archivedAt: new Date(0) }));
  assert.notEqual(pageSnapshotHash(base), pageSnapshotHash({ ...base, sourceId: "source-1" }));
});

test("Source hash는 추출 본문과 storageKey를 모두 포함한다", () => {
  const base = { title: "원문", url: null, body: "본문", storageKey: null, modelAccess: "external", archivedAt: null };
  assert.notEqual(sourceSnapshotHash(base), sourceSnapshotHash({ ...base, body: "수정" }));
  assert.notEqual(sourceSnapshotHash(base), sourceSnapshotHash({ ...base, storageKey: "wiki/blob" }));
});

test("document metadata 변경은 Page snapshot hash에 포함된다", () => {
  const base = {
    title: "결정 기록",
    body: "본문",
    kind: "document",
    documentType: "decision",
    documentAt: new Date("2026-07-21T00:00:00Z"),
    frontmatter: null,
    category: null,
    parentId: null,
    sortOrder: 0,
    sourceId: null,
    origin: "human",
    modelAccess: "external",
    archivedAt: null,
    suppressedAt: null,
    staleAt: null,
  };
  assert.notEqual(pageSnapshotHash(base), pageSnapshotHash({ ...base, documentType: "worklog" }));
  assert.notEqual(pageSnapshotHash(base), pageSnapshotHash({ ...base, documentAt: new Date("2026-07-22T00:00:00Z") }));
});
