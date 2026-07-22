import test from "node:test";
import assert from "node:assert/strict";
import { zipChildIngestInput } from "./zip-ingest";

test("ZIP child run은 부모 preserve/curate mode와 modelAccess를 그대로 상속한다", () => {
  const base = { storageKey: "wiki/blob.txt", filename: "blob.txt", mimeType: "text/plain", size: 4 };
  assert.deepEqual(zipChildIngestInput({ ...base, mode: "preserve", modelAccess: "external" }), {
    ...base,
    mode: "preserve",
    modelAccess: "external",
  });
  assert.deepEqual(zipChildIngestInput({ ...base, mode: "curate", modelAccess: "internalOnly" }), {
    ...base,
    mode: "curate",
    modelAccess: "internalOnly",
  });
});
