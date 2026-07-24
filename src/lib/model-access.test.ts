import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_MODEL_SCOPE,
  MODEL_POLICY_DISPATCH_LEASE_MS,
  MODEL_POLICY_LEASE_SAFETY_MARGIN_MS,
  MODEL_POLICY_SHARED_LOCK_TIMEOUT_MS,
  MODEL_POLICY_TRANSACTION_TIMEOUT_MS,
  MODEL_POLICY_WRITE_LEASE_MS,
  MODEL_POLICY_WRITE_LOCK_TIMEOUT_MS,
  ModelPolicyLeaseExpiredError,
  assertExternalModelScope,
  createModelPolicyDispatchLease,
  isExternalModelEligible,
  normalizeModelAccess,
  strictestModelAccess,
} from "./model-access";

const waitForAbort = (signal: AbortSignal) => new Promise<unknown>((resolve) => {
  if (signal.aborted) resolve(signal.reason);
  else signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
});

test("personal은 요청값과 무관하게 internalOnly로 정규화된다", () => {
  assert.equal(normalizeModelAccess("personal", "external"), "internalOnly");
  assert.equal(normalizeModelAccess("personal", undefined), "internalOnly");
});

test("일반 페이지 기본값은 external이고 명시적 internalOnly는 유지된다", () => {
  assert.equal(normalizeModelAccess("concept", undefined), "external");
  assert.equal(normalizeModelAccess("entity", "internalOnly"), "internalOnly");
});

test("strictestModelAccess는 복원 대상 external로 현재 internalOnly를 완화하지 않는다", () => {
  assert.equal(strictestModelAccess("internalOnly", "external"), "internalOnly");
  assert.equal(strictestModelAccess("external", "internalOnly"), "internalOnly");
  assert.equal(strictestModelAccess("external", "external"), "external");
});

test("external model eligibility는 정책·archive·personal을 모두 검사한다", () => {
  assert.equal(isExternalModelEligible({ modelAccess: "external", archivedAt: null, kind: "concept" }), true);
  assert.equal(isExternalModelEligible({ modelAccess: "internalOnly", archivedAt: null, kind: "concept" }), false);
  assert.equal(isExternalModelEligible({ modelAccess: "external", archivedAt: new Date(), kind: "concept" }), false);
  assert.equal(isExternalModelEligible({ modelAccess: "external", archivedAt: null, kind: "personal" }), false);
});

test("외부 모델 scope는 명시적인 capability token만 허용한다", () => {
  assert.doesNotThrow(() => assertExternalModelScope(EXTERNAL_MODEL_SCOPE));
  assert.throws(() => assertExternalModelScope({ trust: "internal" } as never), /지원하지 않는/);
});

test("model dispatch lease는 transaction timeout보다 60초 먼저 만료된다", () => {
  assert.equal(MODEL_POLICY_LEASE_SAFETY_MARGIN_MS, 60_000);
  assert.equal(
    MODEL_POLICY_DISPATCH_LEASE_MS + MODEL_POLICY_LEASE_SAFETY_MARGIN_MS,
    MODEL_POLICY_TRANSACTION_TIMEOUT_MS,
  );
  assert.ok(MODEL_POLICY_SHARED_LOCK_TIMEOUT_MS < MODEL_POLICY_DISPATCH_LEASE_MS);
  assert.ok(MODEL_POLICY_DISPATCH_LEASE_MS < MODEL_POLICY_WRITE_LOCK_TIMEOUT_MS);
  assert.ok(MODEL_POLICY_WRITE_LOCK_TIMEOUT_MS < MODEL_POLICY_WRITE_LEASE_MS);
  assert.ok(MODEL_POLICY_WRITE_LEASE_MS < MODEL_POLICY_TRANSACTION_TIMEOUT_MS);
});

test("model dispatch lease 만료는 active provider turn과 후속 dispatch를 fail-closed로 막는다", async () => {
  const lease = createModelPolicyDispatchLease(20);
  // lease 타이머는 운영에서 프로세스를 붙잡지 않도록 unref돼 있어, 이 대기를 ref된
  // 타이머로 받쳐주지 않으면 이벤트 루프가 먼저 비는 Node 버전에서 abort 전에 러너가 종료된다.
  const keepalive = setTimeout(() => {}, 5_000);
  try {
    const reason = await waitForAbort(lease.signal);
    assert.ok(reason instanceof ModelPolicyLeaseExpiredError);
    assert.throws(() => lease.assertActive(), ModelPolicyLeaseExpiredError);
  } finally {
    clearTimeout(keepalive);
    lease.dispose();
  }
});

test("policy transaction 정상 종료도 lease를 닫아 미대기 child dispatch를 막는다", () => {
  const lease = createModelPolicyDispatchLease(60_000);
  lease.dispose();
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertActive(), /lease closed/);
});
