import assert from "node:assert/strict";
import { test } from "node:test";
import type { TocSection } from "./kinds";
import type { TocSelectionPage } from "./toc-selection";
import {
  collectTocCategoryTargets,
  hasCrossedTocPageDragThreshold,
  tocDropTargetState,
  tocEdgeAutoScrollDelta,
  tocPageMovePayloadForHandle,
} from "./toc-page-move";

const pages: TocSelectionPage[] = [
  { slug: "a", title: "A", category: "one", currentVersion: 2, movable: true, trashable: true },
  { slug: "b", title: "B", category: "two", currentVersion: 3, movable: true, trashable: true },
  { slug: "locked", title: "Locked", category: null, currentVersion: 1, movable: false, trashable: false },
];

test("5px 이동은 클릭이고 6px 이상부터 페이지 드래그다", () => {
  assert.equal(hasCrossedTocPageDragThreshold({ x: 10, y: 10 }, { x: 13, y: 14 }), false);
  assert.equal(hasCrossedTocPageDragThreshold({ x: 10, y: 10 }, { x: 16, y: 10 }), true);
});

test("선택된 손잡이는 canonical 선택 전체, 선택되지 않은 손잡이는 단건과 선택 교체를 만든다", () => {
  const selected = new Set(["a", "b"]);
  assert.deepEqual(tocPageMovePayloadForHandle(pages[0], pages, selected, true), {
    pages: pages.slice(0, 2),
    items: [{ slug: "a", expectedVersion: 2 }, { slug: "b", expectedVersion: 3 }],
    replaceSelection: false,
  });
  assert.deepEqual(tocPageMovePayloadForHandle(pages[1], pages, new Set(["a"]), true), {
    pages: [pages[1]],
    items: [{ slug: "b", expectedVersion: 3 }],
    replaceSelection: true,
  });
  assert.equal(tocPageMovePayloadForHandle(pages[2], pages, new Set(), false), null);
});

test("모두 현재 폴더면 no-op이고 일부만 현재면 유효한 일괄 대상이다", () => {
  assert.equal(tocDropTargetState([pages[0]], "one"), "current");
  assert.equal(tocDropTargetState(pages.slice(0, 2), "one"), "valid");
  assert.equal(tocDropTargetState([pages[0]], null), "valid");
  assert.equal(tocDropTargetState([], null), "invalid");
});

test("canonical 폴더와 고정 빈 폴더를 중복 없이 모으고 root를 첫 대상으로 둔다", () => {
  const sections: TocSection[] = [{
    key: "documents",
    entries: [{
      type: "folder",
      name: "one",
      path: "one",
      children: [{
        type: "folder",
        name: "child",
        path: "one/child",
        children: [],
      }],
    }],
  }];
  assert.deepEqual(collectTocCategoryTargets(sections, ["one", "empty/pinned"]), [
    null,
    "one",
    "one/child",
    "empty/pinned",
  ]);
});

test("가장자리 자동 스크롤은 nav 안쪽에서만 방향과 세기를 계산한다", () => {
  assert.ok(tocEdgeAutoScrollDelta(105, 100, 500) < 0);
  assert.equal(tocEdgeAutoScrollDelta(300, 100, 500), 0);
  assert.ok(tocEdgeAutoScrollDelta(495, 100, 500) > 0);
  assert.equal(tocEdgeAutoScrollDelta(90, 100, 500), 0);
});
