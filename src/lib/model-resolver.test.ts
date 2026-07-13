import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPreferredModel } from "./model-resolver";

test("selectPreferredModel은 선호순에서 호출 가능한 첫 모델을 고른다", async () => {
  const tried: string[] = [];
  const probe = async (id: string) => {
    tried.push(id);
    return id === "gpt-5.5"; // 5.6은 실패, 5.5만 통과
  };
  const picked = await selectPreferredModel(probe, ["gpt-5.6", "gpt-5.5", "gpt-5.1"]);
  assert.equal(picked, "gpt-5.5");
  assert.deepEqual(tried, ["gpt-5.6", "gpt-5.5"]); // 통과 즉시 멈춤(5.1은 안 봄)
});

test("selectPreferredModel은 첫 모델이 통과하면 나머지를 프로브하지 않는다", async () => {
  const tried: string[] = [];
  const probe = async (id: string) => {
    tried.push(id);
    return true;
  };
  const picked = await selectPreferredModel(probe, ["gpt-5.6", "gpt-5.5"]);
  assert.equal(picked, "gpt-5.6");
  assert.deepEqual(tried, ["gpt-5.6"]);
});

test("selectPreferredModel은 전부 실패하면 null을 돌려준다(호출부가 env 폴백)", async () => {
  const picked = await selectPreferredModel(async () => false, ["gpt-5.6", "gpt-5.5"]);
  assert.equal(picked, null);
});
