import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeBuildStage } from "./build-ui";

test("knowledgeBuildStage: artifact coverage로 extraction→staging→publishing을 구분한다", () => {
  assert.equal(knowledgeBuildStage({ status: "pending", inputCount: 2, extractionCount: 0, draftCount: 0 }), "queued");
  assert.equal(knowledgeBuildStage({ status: "running", inputCount: 2, extractionCount: 1, draftCount: 0 }), "extracting");
  assert.equal(knowledgeBuildStage({ status: "running", inputCount: 2, extractionCount: 2, draftCount: 0 }), "staging");
  assert.equal(knowledgeBuildStage({ status: "running", inputCount: 2, extractionCount: 2, draftCount: 3 }), "publishing");
  assert.equal(knowledgeBuildStage({ status: "review", inputCount: 2, extractionCount: 2, draftCount: 3 }), "review");
  assert.equal(knowledgeBuildStage({ status: "publishedDegraded", inputCount: 2, extractionCount: 2, draftCount: 3 }), "done");
  assert.equal(knowledgeBuildStage({ status: "failed", inputCount: 2, extractionCount: 1, draftCount: 0 }), "stopped");
});
