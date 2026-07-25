import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeBadges, type KnowledgeBadgeLabels } from "../components/KnowledgeBadges";
import { RevisionDiff, type RevisionDiffLabels } from "../components/RevisionDiff";
import { RevisionHistoryView, type RevisionHistoryLabels } from "../components/RevisionHistoryView";

const badgeLabels: KnowledgeBadgeLabels = {
  origin: { human: "직접 작성", generated: "AI 생성", mixed: "혼합", system: "시스템" },
  modelAccess: { external: "외부 AI 허용", internalOnly: "외부 AI 제외" },
  group: "문서 상태",
};

const diffLabels: RevisionDiffLabels = {
  region: "리비전 차이",
  title: "제목",
  category: "카테고리",
  body: "본문",
  before: "이전",
  after: "이후",
  added: "추가",
  removed: "삭제",
  unchanged: "변경 없음",
  fallbackSize: "문서가 커서 전체 스냅샷을 표시합니다.",
  fallbackComplexity: "차이가 커서 전체 스냅샷을 표시합니다.",
  empty: "빈 값",
};

test("KnowledgeBadges: origin·modelAccess를 icon+텍스트로 렌더한다", () => {
  const html = renderToStaticMarkup(
    KnowledgeBadges({ origin: "mixed", modelAccess: "internalOnly", labels: badgeLabels }),
  );
  assert.match(html, /혼합/);
  assert.match(html, /외부 AI 제외/);
  assert.match(html, /aria-label="문서 상태"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
});

test("RevisionDiff: 추가·삭제를 semantic element와 텍스트 범례로 렌더한다", () => {
  const html = renderToStaticMarkup(
    RevisionDiff({
      before: { title: "문서", body: "오늘 날씨", category: null },
      after: { title: "문서", body: "내일 날씨", category: null },
      labels: diffLabels,
    }),
  );
  assert.match(html, /role="region"/);
  assert.match(html, /<ins/);
  assert.match(html, /<del/);
  assert.match(html, />추가</);
  assert.match(html, />삭제</);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /focus-visible:ring-2/);
});

test("RevisionDiff: 대용량 fallback은 이전·이후를 좁은 화면 1열, 넓은 화면 2열로 렌더한다", () => {
  const html = renderToStaticMarkup(
    RevisionDiff({
      before: { title: "문서", body: "a".repeat(30), category: null },
      after: { title: "문서", body: "b".repeat(30), category: null },
      labels: diffLabels,
      limits: { maxChars: 40 },
    }),
  );
  assert.match(html, /문서가 커서/);
  assert.match(html, /grid-cols-1/);
  assert.match(html, /lg:grid-cols-2/);
  assert.equal((html.match(/<pre/g) ?? []).length, 2);
});

test("RevisionDiff: 스냅샷 문자열을 HTML로 실행하지 않는다", () => {
  const html = renderToStaticMarkup(
    RevisionDiff({
      before: { title: "문서", body: "", category: null },
      after: { title: "문서", body: '<script>alert("x")</script>', category: null },
      labels: diffLabels,
    }),
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("RevisionHistoryView: actor rail·현재 버전·선택 상태를 색 외 텍스트로도 표시한다", () => {
  const labels: RevisionHistoryLabels = {
    back: "페이지",
    heading: "변경 기록",
    subtitle: "전체 스냅샷",
    timeline: "버전 타임라인",
    current: "현재",
    selected: "선택한 revision",
    compareHeading: "버전 비교",
    initialSnapshot: "최초 스냅샷",
    actor: { human: "사람", agent: "AI 에이전트", system: "시스템", restore: "복원" },
    reasonFallback: "사유 없음",
    stateHeading: "저장 상태",
    kind: "종류",
    modelAccess: "AI 정책",
    documentState: "문서 상태",
    archived: "아카이브",
    active: "활성",
    contentHash: "해시",
    sources: "근거",
    restore: "복원",
    restoring: "복원 중",
    restoreConfirm: "복원할까요?",
    restoreNotice: "새 revision을 만듭니다.",
    restoreFailed: "복원 실패",
    empty: "없음",
    previousPage: "최신 기록",
    nextPage: "이전 기록",
  };
  const html = renderToStaticMarkup(
    RevisionHistoryView({
      backHref: "/page",
      revisions: [
        {
          id: "r2",
          version: 2,
          title: "새 제목",
          body: "새 본문",
          category: null,
          actor: "agent",
          reason: "AI 제안",
          createdAtLabel: "2026-07-10 12:00",
          modelAccess: "external",
          origin: "generated",
          kind: "concept",
          archivedAt: null,
          contentHash: "hash-2",
          sourceCount: 1,
        },
        {
          id: "r1",
          version: 1,
          title: "이전 제목",
          body: "이전 본문",
          category: null,
          actor: "human",
          reason: null,
          createdAtLabel: "2026-07-10 11:00",
          modelAccess: "external",
          origin: "human",
          kind: "concept",
          archivedAt: null,
          contentHash: "hash-1",
          sourceCount: 0,
        },
      ],
      currentVersion: 2,
      selectedId: "r2",
      hrefForRevision: (id) => `/history?revision=${id}`,
      labels,
      diffLabels,
      badgeLabels,
      canRestore: false,
      restoreApiUrl: "/api/revisions",
    }),
  );
  assert.match(html, /AI 에이전트/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, />현재</);
  assert.match(html, /border-l-indigo-500/);
  assert.match(html, /v1 → v2/);
});
