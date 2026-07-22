import test from "node:test";
import assert from "node:assert/strict";
import { parseIngestMode } from "./ingest";

test("ingest mode 생략은 curate로 하위 호환된다", () => {
  assert.equal(parseIngestMode(undefined), "curate");
});

test("ingest mode는 preserve/curate만 허용하고 null·빈값·오타를 거부한다", () => {
  assert.equal(parseIngestMode("preserve"), "preserve");
  assert.equal(parseIngestMode("curate"), "curate");
  assert.equal(parseIngestMode(null), null);
  assert.equal(parseIngestMode(""), null);
  assert.equal(parseIngestMode("archive"), null);
});
