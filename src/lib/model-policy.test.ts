import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planPageModelAccessTransition,
  planSourceDependentPageEffect,
  planSourceModelAccessTransition,
} from "./model-policy";

test("personal Page는 external 요청도 internalOnly로 강제하고 완화 확인을 요구하지 않는다", () => {
  const plan = planPageModelAccessTransition({
    kind: "personal",
    current: "internalOnly",
    requested: "external",
  });
  assert.deepEqual(plan, {
    current: "internalOnly",
    requested: "external",
    effective: "internalOnly",
    changed: false,
    isRelaxation: false,
    confirmationRequired: false,
  });
});

test("일반 Page와 Source의 internalOnly → external만 명시적 확인 대상이다", () => {
  const pageUpgrade = planPageModelAccessTransition({
    kind: "concept",
    current: "internalOnly",
    requested: "external",
  });
  const sourceUpgrade = planSourceModelAccessTransition({
    current: "internalOnly",
    requested: "external",
  });
  const sourceDowngrade = planSourceModelAccessTransition({
    current: "external",
    requested: "internalOnly",
  });

  assert.equal(pageUpgrade.confirmationRequired, true);
  assert.equal(sourceUpgrade.confirmationRequired, true);
  assert.equal(sourceDowngrade.confirmationRequired, false);
  assert.equal(sourceDowngrade.effective, "internalOnly");
});

test("Source downgrade는 note와 contribution의 출처와 무관하게 internalOnly/stale로 전파한다", () => {
  for (const role of ["note", "contribution"] as const) {
    for (const origin of ["human", "generated", "mixed", "system"] as const) {
      assert.deepEqual(
        planSourceDependentPageEffect({
          mode: "downgrade",
          role,
          origin,
          currentModelAccess: "external",
          sourceModelAccess: "internalOnly",
        }),
        { archive: false, markStale: true, modelAccess: "internalOnly" },
      );
    }
  }
});

test("Source archive는 note를 lifecycle archive하고 generated contribution만 stale 처리한다", () => {
  assert.deepEqual(
    planSourceDependentPageEffect({
      mode: "archive",
      role: "note",
      origin: "human",
      currentModelAccess: "external",
      sourceModelAccess: "external",
    }),
    { archive: true, markStale: true, modelAccess: "external" },
  );
  assert.deepEqual(
    planSourceDependentPageEffect({
      mode: "archive",
      role: "contribution",
      origin: "generated",
      currentModelAccess: "external",
      sourceModelAccess: "internalOnly",
    }),
    { archive: false, markStale: true, modelAccess: "internalOnly" },
  );
  assert.equal(
    planSourceDependentPageEffect({
      mode: "archive",
      role: "contribution",
      origin: "mixed",
      currentModelAccess: "external",
      sourceModelAccess: "external",
    }),
    null,
  );
});

test("Source archive가 external 정책이면 이미 더 엄격한 Page 정책을 완화하지 않는다", () => {
  assert.deepEqual(
    planSourceDependentPageEffect({
      mode: "archive",
      role: "contribution",
      origin: "generated",
      currentModelAccess: "internalOnly",
      sourceModelAccess: "external",
    }),
    { archive: false, markStale: true, modelAccess: "internalOnly" },
  );
});
