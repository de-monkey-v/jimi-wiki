import { createHash } from "node:crypto";
import { normalizeSlug } from "./markdown";

export const EXTRACTION_PROMPT_VERSION = "source-extraction-v2";
export const SYNTHESIS_PROMPT_VERSION = "knowledge-synthesis-v2";

export type ExtractedClaim = { key: string; text: string; conceptKeys: string[]; confidence?: number };
export type ExtractedConcept = { key: string; title: string; kind: "concept" | "entity"; summary?: string };
export type ExtractedRelation = {
  fromKey: string;
  toKey: string;
  type: "relatedTo" | "partOf" | "causes" | "contrasts" | "dependsOn";
};
export type SourceExtractionData = {
  claims: ExtractedClaim[];
  concepts: ExtractedConcept[];
  entities: ExtractedConcept[];
  relations: ExtractedRelation[];
  sourceNote: string;
};

export type SynthesizedDraftData = {
  slug: string;
  title: string;
  body: string;
  kind: "note" | "concept" | "entity";
  category: string | null;
  sourceRevisionIds: string[];
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function extractionFingerprint(input: {
  sourceHash: string;
  model: string;
  promptVersion?: string;
  rulesHash: string;
}): string {
  return sha256(
    JSON.stringify([
      input.sourceHash,
      input.model,
      input.promptVersion ?? EXTRACTION_PROMPT_VERSION,
      input.rulesHash,
    ]),
  );
}

export function stableKnowledgeKey(value: unknown): string {
  return normalizeSlug(String(value ?? "").normalize("NFKC")).slice(0, 120);
}

/** 카테고리는 페이지 slug와 달리 `/` 계층을 보존한다. */
export function normalizeCategoryPath(value: string): string | null {
  const rawParts = value.trim().split("/");
  if (rawParts.some((part) => !part.trim())) return null;
  const parts = rawParts.map((part) => stableKnowledgeKey(part));
  if (parts.some((part) => !part)) return null;
  const path = parts.join("/");
  return path.length <= 240 ? path : null;
}

/** 모델이 code fence/짧은 서문을 붙여도 첫 균형 JSON object/array만 파싱한다. */
export function parseFirstJson(value: string): unknown {
  const text = value.trim();
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("모델 응답에서 JSON을 찾지 못했습니다");
}

const RELATIONS = new Set(["relatedTo", "partOf", "causes", "contrasts", "dependsOn"]);

// enum 값을 대소문자 무시로 되찾기 위한 정규화 맵(예: "RelatedTo"/"relatedto" → "relatedTo").
const RELATION_CANON = new Map<string, ExtractedRelation["type"]>(
  [...RELATIONS].map((r) => [r.toLowerCase(), r as ExtractedRelation["type"]]),
);
// 프롬프트는 enum(relatedTo|partOf|causes|contrasts|dependsOn)을 지시하지만 LLM이 가끔 온톨로지
// 어휘(is-a, part-of, uses…)나 표기 변형을 낸다. 알려진 동의어를 enum으로 접는다.
const RELATION_SYNONYMS: Record<string, ExtractedRelation["type"]> = {
  uses: "dependsOn",
  "is-a": "relatedTo",
  "part-of": "partOf",
  "example-of": "relatedTo",
  "developed-by": "relatedTo",
  contradicts: "contrasts",
};

/**
 * LLM이 낸 relation type을 지원되는 enum으로 관대하게 강등한다. 관계 하나가 메뉴 밖 값이라고
 * 편입 전체를 throw로 죽이지 않도록 — 미지값은 무향 기본 relatedTo로 접는다(enum 주석의 coerce 의도).
 */
function coerceRelationType(raw: string): ExtractedRelation["type"] {
  const norm = raw.trim().toLowerCase();
  return RELATION_CANON.get(norm) ?? RELATION_SYNONYMS[norm] ?? "relatedTo";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}는 JSON object여야 합니다`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}는 JSON array여야 합니다`);
  return value;
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${label}는 string이어야 합니다`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${label}는 비어 있을 수 없습니다`);
  if (normalized.length > max) throw new Error(`${label} 길이 상한 초과: ${normalized.length}/${max}`);
  return normalized;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label}에 허용되지 않은 필드가 있습니다: ${extras.join(", ")}`);
}

export function normalizeExtraction(raw: unknown): SourceExtractionData {
  const src = record(raw, "extraction");
  onlyKeys(src, ["claims", "concepts", "entities", "relations", "sourceNote"], "extraction");
  const toConcepts = (value: unknown, fallbackKind: "concept" | "entity") => {
    const rows = array(value, `${fallbackKind}s`);
    const out: ExtractedConcept[] = [];
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const item = record(row, `${fallbackKind}s[${index}]`);
      onlyKeys(item, ["key", "title", "kind", "summary"], `${fallbackKind}s[${index}]`);
      const title = text(item.title, `${fallbackKind}s[${index}].title`, 200);
      const rawKey = text(item.key, `${fallbackKind}s[${index}].key`, 200);
      const key = stableKnowledgeKey(rawKey);
      if (!key || key !== rawKey) throw new Error(`${fallbackKind}s[${index}].key는 정규화된 stable key여야 합니다`);
      if (item.kind !== fallbackKind) throw new Error(`${fallbackKind}s[${index}].kind가 ${fallbackKind}가 아닙니다`);
      if (seen.has(key)) throw new Error(`${fallbackKind} key 중복: ${key}`);
      seen.add(key);
      out.push({
        key,
        title,
        kind: fallbackKind,
        ...(item.summary === undefined ? {} : { summary: text(item.summary, `${fallbackKind}s[${index}].summary`, 2_000, true) }),
      });
    }
    if (out.length > 500) throw new Error(`extraction concept 상한 초과: ${out.length}`);
    return out;
  };
  const concepts = toConcepts(src.concepts, "concept");
  const entities = toConcepts(src.entities, "entity");
  const validKeys = new Set([...concepts, ...entities].map((c) => c.key));

  const claims: ExtractedClaim[] = [];
  for (const [index, row] of array(src.claims, "claims").entries()) {
    const item = record(row, `claims[${index}]`);
    onlyKeys(item, ["key", "text", "conceptKeys", "confidence"], `claims[${index}]`);
    const claimText = text(item.text, `claims[${index}].text`, 4_000);
    const rawKey = text(item.key, `claims[${index}].key`, 200);
    const key = stableKnowledgeKey(rawKey);
    if (!key || key !== rawKey) throw new Error(`claims[${index}].key는 정규화된 stable key여야 합니다`);
    const conceptKeys = [...new Set(array(item.conceptKeys, `claims[${index}].conceptKeys`).map((value, keyIndex) => {
      const conceptKey = text(value, `claims[${index}].conceptKeys[${keyIndex}]`, 200);
      if (!validKeys.has(conceptKey)) throw new Error(`claim이 알 수 없는 concept key를 참조합니다: ${conceptKey}`);
      return conceptKey;
    }))];
    if (conceptKeys.length === 0) throw new Error(`claims[${index}].conceptKeys는 비어 있을 수 없습니다`);
    if (item.confidence !== undefined && (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) {
      throw new Error(`claims[${index}].confidence는 0..1 number여야 합니다`);
    }
    claims.push({ key, text: claimText, conceptKeys, ...(item.confidence === undefined ? {} : { confidence: item.confidence }) });
  }

  const relations: ExtractedRelation[] = [];
  for (const [index, row] of array(src.relations, "relations").entries()) {
    const item = record(row, `relations[${index}]`);
    onlyKeys(item, ["fromKey", "toKey", "type"], `relations[${index}]`);
    const fromKey = text(item.fromKey, `relations[${index}].fromKey`, 200);
    const toKey = text(item.toKey, `relations[${index}].toKey`, 200);
    // relation type은 관대하게 coerce한다(미지값 → relatedTo). 참조 무결성(미지 key·self-loop)은
    // 여전히 엄격 — 그건 LLM이 정의하지 않은 개념을 가리키는 진짜 불일치라 조용히 삼키면 안 된다.
    const type = coerceRelationType(text(item.type, `relations[${index}].type`, 40));
    if (!validKeys.has(fromKey) || !validKeys.has(toKey)) throw new Error(`relation이 알 수 없는 concept key를 참조합니다`);
    if (fromKey === toKey) throw new Error(`relation self-loop는 허용되지 않습니다: ${fromKey}`);
    relations.push({ fromKey, toKey, type });
  }

  if (claims.length > 2_000) throw new Error(`extraction claim 상한 초과: ${claims.length}`);
  if (relations.length > 2_000) throw new Error(`extraction relation 상한 초과: ${relations.length}`);
  return {
    claims,
    concepts,
    entities,
    relations,
    sourceNote: text(src.sourceNote, "sourceNote", 20_000, true),
  };
}

export function normalizeDrafts(raw: unknown, allowedSourceRevisionIds: Set<string>): SynthesizedDraftData[] {
  const root = record(raw, "synthesis");
  onlyKeys(root, ["pages"], "synthesis");
  const rows = array(root.pages, "synthesis.pages");
  if (rows.length > 200) throw new Error(`synthesis page 상한 초과: ${rows.length}`);
  const out: SynthesizedDraftData[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const item = record(row, `synthesis.pages[${index}]`);
    onlyKeys(item, ["slug", "title", "body", "kind", "category", "sourceRevisionIds"], `synthesis.pages[${index}]`);
    const rawSlug = text(item.slug, `synthesis.pages[${index}].slug`, 200);
    const slug = stableKnowledgeKey(rawSlug);
    if (!slug || slug !== rawSlug) throw new Error(`synthesis.pages[${index}].slug는 정규화된 stable key여야 합니다`);
    const title = text(item.title, `synthesis.pages[${index}].title`, 200);
    const body = text(item.body, `synthesis.pages[${index}].body`, 100_000);
    if (item.kind !== "note" && item.kind !== "concept" && item.kind !== "entity") {
      throw new Error(`synthesis.pages[${index}].kind가 유효하지 않습니다`);
    }
    const kind = item.kind;
    if (seen.has(slug)) throw new Error(`synthesis page slug 중복: ${slug}`);
    seen.add(slug);
    const sourceRevisionIds = [...new Set(array(item.sourceRevisionIds, `synthesis.pages[${index}].sourceRevisionIds`).map((value, sourceIndex) => {
      const id = text(value, `synthesis.pages[${index}].sourceRevisionIds[${sourceIndex}]`, 200);
      if (!allowedSourceRevisionIds.has(id)) throw new Error(`synthesis가 허용되지 않은 SourceRevision을 참조했습니다: ${id}`);
      return id;
    }))];
    if (sourceRevisionIds.length === 0) throw new Error(`synthesis.pages[${index}] provenance가 비었습니다`);
    let category: string | null = null;
    if (item.category !== null && item.category !== undefined && item.category !== "") {
      const rawCategory = text(item.category, `synthesis.pages[${index}].category`, 240);
      category = normalizeCategoryPath(rawCategory);
      if (!category || category !== rawCategory) throw new Error(`category는 정규화된 slash path여야 합니다: ${rawCategory}`);
    }
    out.push({
      slug,
      title,
      body,
      kind,
      category,
      sourceRevisionIds,
    });
  }
  return out;
}
