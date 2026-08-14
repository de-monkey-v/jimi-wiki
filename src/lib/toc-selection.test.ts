import assert from "node:assert/strict";
import { test } from "node:test";
import type { TocSection } from "./kinds";
import {
  addVisibleRange,
  flattenTocPages,
  reconcileTocSelection,
  selectableSlugsInEntries,
  setTocGroupSelected,
  tocGroupSelectionState,
} from "./toc-selection";

const sections: TocSection[] = [
  {
    key: "documents",
    entries: [
      { type: "page", slug: "root", title: "Root", kind: "document", category: null, currentVersion: 1, movable: true, trashable: true },
      {
        type: "folder",
        name: "Folder",
        path: "folder",
        children: [
          { type: "page", slug: "hidden-a", title: "Hidden A", kind: "document", category: "folder", currentVersion: 2, movable: true, trashable: true },
          { type: "page", slug: "protected", title: "Protected", kind: "document", category: "folder", currentVersion: 1, movable: false, trashable: false },
          { type: "page", slug: "hidden-b", title: "Hidden B", kind: "document", category: "folder", currentVersion: 3, movable: true, trashable: true },
        ],
      },
      { type: "page", slug: "last", title: "Last", kind: "document", category: null, currentVersion: 1, movable: true, trashable: true },
    ],
  },
];

test("목차 선택은 canonical 순서를 보존하고 삭제 불가 leaf를 그룹에서 제외한다", () => {
  assert.deepEqual(flattenTocPages(sections).map((page) => page.slug), [
    "root",
    "hidden-a",
    "protected",
    "hidden-b",
    "last",
  ]);
  const folder = sections[0].entries[1];
  assert.equal(folder.type, "folder");
  if (folder.type === "folder") {
    assert.deepEqual(selectableSlugsInEntries(folder.children), ["hidden-a", "hidden-b"]);
    assert.deepEqual(selectableSlugsInEntries(folder.children, "move"), ["hidden-a", "hidden-b"]);
  }
});

test("Shift 범위는 접힌 자손이 빠진 visible 순서만 추가한다", () => {
  const selected = addVisibleRange(new Set(["hidden-a"]), ["root", "last"], "root", "last");
  assert.deepEqual([...selected].sort(), ["hidden-a", "last", "root"]);

  const fallback = addVisibleRange(new Set(["root"]), ["root", "last"], "not-visible", "last");
  assert.deepEqual([...fallback], ["root", "last"]);
});

test("폴더/전체 선택은 add/remove와 mixed 상태를 일관되게 계산한다", () => {
  const slugs = ["root", "hidden-a", "hidden-b"];
  const partial = setTocGroupSelected(new Set(), slugs.slice(0, 2), true);
  assert.deepEqual(tocGroupSelectionState(partial, slugs), { checked: false, mixed: true, selectedCount: 2 });
  const all = setTocGroupSelected(partial, slugs, true);
  assert.deepEqual(tocGroupSelectionState(all, slugs), { checked: true, mixed: false, selectedCount: 3 });
  assert.deepEqual([...setTocGroupSelected(all, ["hidden-a", "hidden-b"], false)], ["root"]);
});

test("alias나 새 서버 props가 남긴 stale slug는 canonical selectable 집합으로 정리한다", () => {
  const reconciled = reconcileTocSelection(
    new Set(["root", "root", "already-trashed", "protected"]),
    new Set(["root", "last"]),
  );
  assert.deepEqual([...reconciled], ["root"]);
});
