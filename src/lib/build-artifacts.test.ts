import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractionFingerprint,
  normalizeDrafts,
  normalizeCategoryPath,
  normalizeExtraction,
  parseFirstJson,
  stableKnowledgeKey,
} from "./build-artifacts";
import { chunkSourceText, parseBuildInputManifest, parsePublishedBuildManifest } from "./builds";

test("extraction fingerprint는 입력이 같으면 재사용되고 prompt/rules가 바뀌면 달라진다", () => {
  const base = { sourceHash: "source", model: "gpt-5.6", rulesHash: "rules" };
  assert.equal(extractionFingerprint(base), extractionFingerprint(base));
  assert.notEqual(extractionFingerprint(base), extractionFingerprint({ ...base, rulesHash: "rules-2" }));
  assert.notEqual(extractionFingerprint(base), extractionFingerprint({ ...base, promptVersion: "v2" }));
});

test("첫 균형 JSON을 code fence와 서문에서 추출한다", () => {
  assert.deepEqual(parseFirstJson("결과:\n```json\n{\"ok\":true}\n```"), { ok: true });
});

test("extraction은 stable key, claim grounding, 관계를 엄격히 검증한다", () => {
  const normalized = normalizeExtraction({
    concepts: [{ key: "large-language-model", title: "Large Language Model", kind: "concept" }],
    entities: [{ key: "openai", title: "OpenAI", kind: "entity" }],
    claims: [{ key: "claim", text: "A claim", conceptKeys: ["large-language-model"], confidence: 0.9 }],
    relations: [{ fromKey: "large-language-model", toKey: "openai", type: "dependsOn" }],
    sourceNote: "note",
  });
  assert.equal(stableKnowledgeKey(" Large Language Model "), "large-language-model");
  assert.equal(normalized.claims[0].confidence, 0.9);
  assert.deepEqual(normalized.claims[0].conceptKeys, ["large-language-model"]);
  assert.equal(normalized.relations.length, 1);
  assert.equal(normalized.sourceNote, "note");
});

test("메뉴 밖 relation type은 편입을 죽이지 않고 enum으로 coerce된다", () => {
  const normalized = normalizeExtraction({
    concepts: [
      { key: "a", title: "A", kind: "concept" },
      { key: "b", title: "B", kind: "concept" },
      { key: "c", title: "C", kind: "concept" },
      { key: "d", title: "D", kind: "concept" },
    ],
    entities: [],
    claims: [],
    relations: [
      { fromKey: "a", toKey: "b", type: "is-a" }, // 온톨로지 어휘 → relatedTo
      { fromKey: "a", toKey: "c", type: "part-of" }, // → partOf
      { fromKey: "a", toKey: "d", type: "totally-unknown" }, // 미지값 → relatedTo
    ],
    sourceNote: "note",
  });
  assert.deepEqual(
    normalized.relations.map((r) => r.type),
    ["relatedTo", "partOf", "relatedTo"],
  );
});

test("draft는 manifest에 없는 SourceRevision provenance를 거부한다", () => {
  assert.throws(
    () => normalizeDrafts(
      { pages: [{ slug: "page", title: "Page", body: "Body", kind: "concept", category: null, sourceRevisionIds: ["allowed", "forged"] }] },
      new Set(["allowed"]),
    ),
    /허용되지 않은 SourceRevision/,
  );
});

test("모델 JSON의 object coercion과 잘못된 category path를 fail-closed한다", () => {
  assert.throws(() => normalizeExtraction({ claims: [], concepts: [], entities: [], relations: [], sourceNote: {} }), /string/);
  assert.equal(normalizeCategoryPath("ai/models"), "ai/models");
  assert.equal(normalizeCategoryPath("ai//models"), null);
  assert.throws(
    () => normalizeDrafts(
      { pages: [{ slug: "page", title: {}, body: "Body", kind: "concept", category: "ai/models", sourceRevisionIds: ["allowed"] }] },
      new Set(["allowed"]),
    ),
    /title.*string/,
  );
});

test("build manifest는 tenant 입력 identity 중복과 알 수 없는 필드를 거부한다", () => {
  const input = {
    inputs: [{ sourceId: "s1", sourceSlug: "source", sourceRevisionId: "r1", version: 1, policyVersion: 1, contentHash: "hash" }],
  };
  assert.deepEqual(parseBuildInputManifest(input), input);
  assert.throws(() => parseBuildInputManifest({ ...input, leaked: true }), /unknown fields/);
  assert.throws(() => parseBuildInputManifest({ inputs: [...input.inputs, { ...input.inputs[0], sourceRevisionId: "r2" }] }), /duplicate/);
});

test("source chunk는 경계를 overlap하고 원문 전체를 빠짐없이 덮는다", () => {
  const body = `${"a".repeat(58_000)}. ${"b".repeat(10_000)}`;
  const chunks = chunkSourceText(body);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].length <= 60_000);
  assert.ok(chunks[1].startsWith(chunks[0].slice(-2_000)));
  assert.equal(chunks.map((chunk, index) => index === 0 ? chunk : chunk.slice(2_000)).join(""), body);
});

test("published build manifest는 revision/content hash와 실제 관계 snapshot을 엄격히 파싱한다", () => {
  const manifest = {
    pages: [{ pageId: "p", slug: "page", pageRevisionId: "pr", version: 2, contentHash: "hash" }],
    relations: [{
      fromSlug: "page",
      toSlug: "other",
      type: "relatedTo",
      sourceId: "source",
      sourceRevisionId: "source-revision",
    }],
  };
  assert.deepEqual(parsePublishedBuildManifest(manifest), manifest);
  assert.throws(() => parsePublishedBuildManifest({ ...manifest, relations: [{ ...manifest.relations[0], type: "invented" }] }), /invalid/);
});
