import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PAGE_CATEGORY_MOVE_ITEMS,
  parsePageCategoryMoveInput,
  parsePageCategoryTarget,
  parsePageCategoryUndoInput,
} from "./page-category-move";

test("일괄 이동 입력은 보이는 legacy category와 안전한 version을 보존한다", () => {
  assert.deepEqual(parsePageCategoryMoveInput([{ slug: "alpha", expectedVersion: 4 }], "work/notes"), {
    items: [{ slug: "alpha", expectedVersion: 4 }],
    category: "work/notes",
  });
  assert.deepEqual(parsePageCategoryMoveInput([{ slug: "alpha", expectedVersion: 4 }], null)?.category, null);
  assert.equal(parsePageCategoryTarget("Legacy Target"), "Legacy Target");
  assert.equal(parsePageCategoryTarget(""), undefined);
  assert.equal(parsePageCategoryTarget(" Needs Normalize "), undefined);
  assert.equal(parsePageCategoryTarget("invalid//path"), undefined);
  assert.equal(parsePageCategoryTarget("invalid\u0000path"), undefined);
  assert.equal(parsePageCategoryTarget({}), undefined);
});

test("같은 slug는 같은 version이어도 거부하고 malformed·oversized 요청도 거부한다", () => {
  assert.equal(parsePageCategoryMoveInput([], null), null);
  assert.equal(parsePageCategoryMoveInput(undefined, null), null);
  assert.equal(parsePageCategoryMoveInput([
    { slug: "alpha", expectedVersion: 1 },
    { slug: "alpha", expectedVersion: 1 },
  ], null), null);
  assert.equal(parsePageCategoryMoveInput([{ slug: "alpha", expectedVersion: 0 }], null), null);
  assert.equal(parsePageCategoryMoveInput([{ slug: "alpha", expectedVersion: Number.NaN }], null), null);
  assert.equal(parsePageCategoryMoveInput([{ slug: " Alpha ", expectedVersion: 1 }], null), null);
  assert.equal(parsePageCategoryMoveInput(
    Array.from({ length: MAX_PAGE_CATEGORY_MOVE_ITEMS + 1 }, (_, index) => ({ slug: `p-${index}`, expectedVersion: 1 })),
    null,
  ), null);
});

test("Undo는 항목별 원래 category와 이동 후 version을 요구한다", () => {
  assert.deepEqual(parsePageCategoryUndoInput([
    { slug: "alpha", expectedVersion: 2, originalCategory: "old/a" },
    { slug: "beta", expectedVersion: 5, originalCategory: null },
  ]), [
    { slug: "alpha", expectedVersion: 2, originalCategory: "old/a" },
    { slug: "beta", expectedVersion: 5, originalCategory: null },
  ]);
  assert.equal(parsePageCategoryUndoInput([{ slug: "alpha", expectedVersion: 2 }]), null);
  assert.equal(parsePageCategoryUndoInput([
    { slug: "alpha", expectedVersion: 2, originalCategory: null },
    { slug: "alpha", expectedVersion: 2, originalCategory: null },
  ]), null);
});
