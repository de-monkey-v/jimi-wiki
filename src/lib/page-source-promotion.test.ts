import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPageSourcePromotionEligible,
  pageSourcePromotionReason,
  pageSourcePromotionRootSlug,
} from "@/lib/page-source-promotion";

test("page Source 편입은 active human/mixed knowledge Page에만 허용한다", () => {
  for (const origin of ["human", "mixed"] as const) {
    for (const kind of ["concept", "entity", "meta"] as const) {
      assert.equal(isPageSourcePromotionEligible({ origin, kind, archivedAt: null, reserved: false }), true);
    }
  }

  assert.equal(isPageSourcePromotionEligible({ origin: "generated", kind: "concept", archivedAt: null, reserved: false }), false);
  assert.equal(isPageSourcePromotionEligible({ origin: "system", kind: "meta", archivedAt: null, reserved: false }), false);
  assert.equal(isPageSourcePromotionEligible({ origin: "human", kind: "note", archivedAt: null, reserved: false }), false);
  assert.equal(isPageSourcePromotionEligible({ origin: "human", kind: "personal", archivedAt: null, reserved: false }), false);
  assert.equal(isPageSourcePromotionEligible({ origin: "human", kind: "concept", archivedAt: new Date(), reserved: false }), false);
  assert.equal(isPageSourcePromotionEligible({ origin: "human", kind: "concept", archivedAt: null, reserved: true }), false);
});

test("PageRevision 기반 편입 identity와 Source slug는 결정적이다", () => {
  const reason = pageSourcePromotionReason("revision-cuid-123");
  const first = pageSourcePromotionRootSlug("  사람 작성 / 문서  ", 7, "revision-cuid-123");
  const second = pageSourcePromotionRootSlug("  사람 작성 / 문서  ", 7, "revision-cuid-123");

  assert.equal(reason, "promoted from PageRevision:revision-cuid-123");
  assert.equal(first, second);
  assert.match(first, /^page-사람-작성-문서-v7-/);
  assert.doesNotMatch(first, /\s|\//);
});
