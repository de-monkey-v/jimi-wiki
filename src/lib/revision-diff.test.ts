import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRevisionDiff, buildTextDiff, type DiffSegment } from "./revision-diff";

function reconstruct(segments: DiffSegment[], side: "before" | "after"): string {
  return segments
    .filter((part) => (side === "before" ? part.kind !== "added" : part.kind !== "removed"))
    .map((part) => part.value)
    .join("");
}

test("buildTextDiff: 단어 diff는 이전·이후 문자열을 손실 없이 복원한다", () => {
  const result = buildTextDiff("안녕 오늘", "안녕 내일", { granularity: "word" });
  assert.equal(result.mode, "diff");
  if (result.mode !== "diff") return;
  assert.equal(result.changed, true);
  assert.equal(reconstruct(result.segments, "before"), "안녕 오늘");
  assert.equal(reconstruct(result.segments, "after"), "안녕 내일");
  assert.ok(result.segments.some((part) => part.kind === "removed"));
  assert.ok(result.segments.some((part) => part.kind === "added"));
});

test("buildTextDiff: line diff는 인접한 삭제·추가 블록을 단어 단위로 세분화한다", () => {
  const before = "# 제목\n오늘은 맑음\n공통 문장\n";
  const after = "# 제목\n내일은 맑음\n공통 문장\n";
  const result = buildTextDiff(before, after, { granularity: "line" });
  assert.equal(result.mode, "diff");
  if (result.mode !== "diff") return;
  assert.equal(reconstruct(result.segments, "before"), before);
  assert.equal(reconstruct(result.segments, "after"), after);
  assert.ok(result.segments.some((part) => part.kind === "unchanged" && part.value.includes("맑음")));
});

test("buildTextDiff: 동일한 문자열은 변경 없음", () => {
  const result = buildTextDiff("같은 본문", "같은 본문");
  assert.deepEqual(result, {
    mode: "diff",
    changed: false,
    segments: [{ kind: "unchanged", value: "같은 본문" }],
  });
});

test("buildTextDiff: 대용량은 diff를 계산하지 않고 전체 스냅샷으로 fallback", () => {
  const before = "a".repeat(40);
  const after = "b".repeat(40);
  const result = buildTextDiff(before, after, { limits: { maxChars: 50 } });
  assert.deepEqual(result, { mode: "snapshot", changed: true, reason: "size", before, after });
});

test("buildTextDiff: edit distance 상한을 넘으면 complexity fallback", () => {
  const before = "a\nb\nc\nd\n";
  const after = "w\nx\ny\nz\n";
  const result = buildTextDiff(before, after, { limits: { maxEditLength: 1 } });
  assert.equal(result.mode, "snapshot");
  if (result.mode !== "snapshot") return;
  assert.equal(result.reason, "complexity");
  assert.equal(result.before, before);
  assert.equal(result.after, after);
});

test("buildTextDiff: 렌더 segment 상한을 넘으면 complexity fallback", () => {
  const result = buildTextDiff("alpha beta", "alpha gamma", {
    granularity: "word",
    limits: { maxSegments: 1 },
  });
  assert.equal(result.mode, "snapshot");
  if (result.mode !== "snapshot") return;
  assert.equal(result.reason, "complexity");
});

test("buildRevisionDiff: null category를 빈 스냅샷으로 비교한다", () => {
  const result = buildRevisionDiff(
    { title: "문서", body: "본문", category: null },
    { title: "문서", body: "본문", category: "ai/rag" },
  );
  assert.equal(result.changed, true);
  assert.equal(result.title.changed, false);
  assert.equal(result.body.changed, false);
  assert.equal(result.category.mode, "diff");
  if (result.category.mode !== "diff") return;
  assert.equal(reconstruct(result.category.segments, "before"), "");
  assert.equal(reconstruct(result.category.segments, "after"), "ai/rag");
});
