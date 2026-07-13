import { diffLines, diffWordsWithSpace, type Change } from "diff";

export type DiffSegmentKind = "unchanged" | "added" | "removed";

export interface DiffSegment {
  kind: DiffSegmentKind;
  value: string;
}

export type RevisionTextDiff =
  | {
      mode: "diff";
      changed: boolean;
      segments: DiffSegment[];
    }
  | {
      mode: "snapshot";
      changed: true;
      reason: "size" | "complexity";
      before: string;
      after: string;
    };

export interface RevisionSnapshotInput {
  title: string;
  body: string;
  category: string | null;
}

export interface RevisionDiffResult {
  title: RevisionTextDiff;
  body: RevisionTextDiff;
  category: RevisionTextDiff;
  changed: boolean;
}

export interface RevisionDiffLimits {
  /** diff 알고리즘을 시작하지 않고 스냅샷 비교로 내릴 두 본문의 합산 문자 수. */
  maxChars: number;
  /** 두 본문의 합산 줄 수 상한. */
  maxLines: number;
  /** jsdiff가 탐색할 최대 edit distance. */
  maxEditLength: number;
  /** 동기 diff가 서버 렌더를 오래 막지 않도록 하는 상한. */
  timeoutMs: number;
  /** 인접한 삭제/추가 줄 블록을 단어 diff로 세분화할 문자 수 상한. */
  maxWordRefineChars: number;
  /** React가 한번에 렌더할 변경 segment 수 상한. */
  maxSegments: number;
}

export const DEFAULT_REVISION_DIFF_LIMITS: Readonly<RevisionDiffLimits> = {
  maxChars: 200_000,
  maxLines: 5_000,
  maxEditLength: 4_000,
  timeoutMs: 150,
  maxWordRefineChars: 20_000,
  maxSegments: 2_000,
};

function segment(change: Change): DiffSegment {
  return {
    kind: change.added ? "added" : change.removed ? "removed" : "unchanged",
    value: change.value,
  };
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) count++;
  return count;
}

function overSizeLimit(before: string, after: string, limits: RevisionDiffLimits): boolean {
  return before.length + after.length > limits.maxChars || lineCount(before) + lineCount(after) > limits.maxLines;
}

function abortableOptions(limits: RevisionDiffLimits) {
  return { timeout: limits.timeoutMs, maxEditLength: limits.maxEditLength };
}

function refineChangedLinePairs(changes: Change[], limits: RevisionDiffLimits): DiffSegment[] | undefined {
  const out: DiffSegment[] = [];
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i];
    const next = changes[i + 1];
    const isPair =
      next &&
      ((current.removed && next.added) || (current.added && next.removed)) &&
      current.value.length + next.value.length <= limits.maxWordRefineChars;

    if (!isPair) {
      out.push(segment(current));
      continue;
    }

    const removed = current.removed ? current.value : next.value;
    const added = current.added ? current.value : next.value;
    const words = diffWordsWithSpace(removed, added, abortableOptions(limits));
    if (!words) return undefined;
    out.push(...words.map(segment));
    i++;
  }
  return out;
}

export function buildTextDiff(
  before: string,
  after: string,
  options?: { granularity?: "line" | "word"; limits?: Partial<RevisionDiffLimits> },
): RevisionTextDiff {
  if (before === after) {
    return { mode: "diff", changed: false, segments: before ? [{ kind: "unchanged", value: before }] : [] };
  }

  const limits = { ...DEFAULT_REVISION_DIFF_LIMITS, ...options?.limits };
  if (overSizeLimit(before, after, limits)) {
    return { mode: "snapshot", changed: true, reason: "size", before, after };
  }

  const changes =
    options?.granularity === "word"
      ? diffWordsWithSpace(before, after, abortableOptions(limits))
      : diffLines(before, after, abortableOptions(limits));
  if (!changes) {
    return { mode: "snapshot", changed: true, reason: "complexity", before, after };
  }

  const segments =
    options?.granularity === "word" ? changes.map(segment) : refineChangedLinePairs(changes, limits);
  if (!segments || segments.length > limits.maxSegments) {
    return { mode: "snapshot", changed: true, reason: "complexity", before, after };
  }
  return { mode: "diff", changed: true, segments };
}

export function buildRevisionDiff(
  before: RevisionSnapshotInput,
  after: RevisionSnapshotInput,
  limits?: Partial<RevisionDiffLimits>,
): RevisionDiffResult {
  const title = buildTextDiff(before.title, after.title, { granularity: "word", limits });
  const body = buildTextDiff(before.body, after.body, { granularity: "line", limits });
  const category = buildTextDiff(before.category ?? "", after.category ?? "", { granularity: "word", limits });
  return {
    title,
    body,
    category,
    changed: title.changed || body.changed || category.changed,
  };
}
