import Link from "next/link";

export const metadata = {
  title: "연동 가이드 — jimi-wiki",
  description: "이 위키를 앱 내부 AI 없이 외부 도구(MCP·Skill·REST)로 유지보수하는 법",
};

// 코드 예시에 들어갈 위키 slug. 슬러그 허용 문자(한글·영문·숫자·-_)만 통과시켜
// 명령 인젝션/깨짐을 막는다. 없으면 플레이스홀더.
function sanitizeSlug(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 80);
  return cleaned || null;
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-800">
      <code>{children}</code>
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border rounded-lg p-5 space-y-3">
      <h2 className="font-semibold text-stone-800">{title}</h2>
      {children}
    </section>
  );
}

export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<{ wiki?: string | string[] }>;
}) {
  const { wiki } = await searchParams;
  const slug = sanitizeSlug(wiki);
  const SLUG = slug ?? "<위키-slug>";
  const BASE = "http://localhost:3007"; // 배포 환경에서는 호스트만 바뀐다

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 space-y-6">
      <div>
        <Link href={slug ? `/wikis/${slug}` : "/wikis"} className="text-sm text-gray-400 hover:underline">
          ← {slug ? "위키로" : "내 위키"}
        </Link>
        <h1 className="text-2xl font-bold mt-1">연동 가이드</h1>
        <p className="text-sm text-gray-500">
          이 위키를 <strong>앱 내부 AI 없이</strong> 외부 도구로 유지보수하는 법 — Claude Code의 MCP·Skill,
          그리고 REST API. 어느 경로로 쓰든 같은 콘텐츠 API와 분류 규칙을 따르므로 위키의 일관성이 유지됩니다.
          {slug ? (
            <>
              {" "}아래 예시의 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">{slug}</code>는 지금
              위키의 slug로 채워져 있습니다.
            </>
          ) : (
            <> 예시의 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">{SLUG}</code>는 대상 위키의 slug로 바꾸세요.</>
          )}
        </p>
      </div>

      <Section title="1. 먼저 — API 키 발급">
        <p className="text-sm text-stone-600">
          모든 외부 호출은 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">Authorization: Bearer &lt;키&gt;</code> 헤더로
          인증합니다. 원문 키는 발급 시 한 번만 표시되니 안전하게 보관하세요.
        </p>
        <ul className="list-disc pl-5 text-sm text-stone-600 space-y-1">
          <li><Link href="/keys" className="text-stone-800 underline hover:text-stone-950">API 키</Link> 화면에서 발급 (쓰기 작업은 editor 이상).</li>
          <li>키를 특정 위키로 <strong>스코프</strong>하거나 <strong>상한 역할(maxRole)</strong>·<strong>만료일</strong>을 걸 수 있습니다. 유효 역할 = min(멤버십 역할, maxRole).</li>
          <li>계정당 활성 키 최대 20개. 레이트리밋: 분당 60회 / 시간당 1000회(초과 시 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">429</code> + Retry-After).</li>
        </ul>
      </Section>

      <Section title="2. 방법 A — MCP 서버 (권장)">
        <p className="text-sm text-stone-600">
          저장소의 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">mcp/server.mjs</code>를 MCP 클라이언트에 등록하면
          콘텐츠 API가 도구로 노출됩니다. Claude Code 예:
        </p>
        <CodeBlock>{`claude mcp add jimi-wiki \\
  -e JIMI_WIKI_URL=${BASE} \\
  -e JIMI_WIKI_API_KEY=<발급받은-키> \\
  -e JIMI_WIKI_SLUG=${SLUG} \\
  -- node <repo>/mcp/server.mjs`}</CodeBlock>
        <p className="text-sm text-stone-600">노출되는 도구(11종):</p>
        <p className="text-sm text-stone-600">
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">search_wiki</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">list_pages</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">read_page</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">write_page</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">create_source</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">list_sources</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">read_source</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">get_ontology</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">match_category</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">run_lint</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">delete_page</code>
        </p>
      </Section>

      <Section title="3. 방법 B — Claude Code Skill">
        <p className="text-sm text-stone-600">
          저장소의 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">skills/wiki-ingest/SKILL.md</code> 스킬은
          외부 유지보수자용 ingest 워크플로우입니다. 내부 ingest 에이전트와 <strong>동일한 분류 규칙</strong>(온톨로지/카테고리)을
          따르도록 정본 규칙이 vendoring되어 있어, 웹 UI로 넣든 스킬로 넣든 위키의 분류가 일관됩니다.
        </p>
        <p className="text-sm text-stone-600">
          절차: ① <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">create_source</code>로 원문 불변 저장 →
          ② <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">search</code>/<code className="rounded bg-stone-100 px-1 py-0.5 text-xs">list_pages</code>로 중복 확인 →
          ③ <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">kind=note</code> 소스 노트 작성(원문 복붙 금지, 요약) →
          ④ 영향받는 concept/entity 갱신(<code className="rounded bg-stone-100 px-1 py-0.5 text-xs">[[slug]]</code> 링크·category 재사용) →
          ⑤ 마지막 호출에 <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">embed:true</code>로 시맨틱 색인.
        </p>
      </Section>

      <Section title="4. 방법 C — REST 직접 호출">
        <p className="text-sm text-stone-600">
          베이스 URL: <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">{BASE}/api/wikis/{SLUG}</code>
        </p>
        <CodeBlock>{`KEY="jw_..."; BASE="${BASE}/api/wikis/${SLUG}"

# 페이지 목록
curl -sH "Authorization: Bearer $KEY" "$BASE/pages"

# 원문 저장(1단계) → slug 반환
curl -sX POST "$BASE/sources" -H "Authorization: Bearer $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"title":"제목","body":"...원문 전문...","url":"https://..."}'

# 소스 노트 작성(kind=note, sourceSlug 연결)
curl -sX POST "$BASE/pages" -H "Authorization: Bearer $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"title":"노트","kind":"note","body":"핵심 요약...","sourceSlug":"<원문-slug>"}'

# 개념 페이지 + 마지막에 임베딩 색인
curl -sX POST "$BASE/pages" -H "Authorization: Bearer $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"title":"Self-Attention","kind":"concept","category":"ai/architectures","body":"[[노트]] 참조...","embed":true}'

# 하이브리드 검색
curl -sH "Authorization: Bearer $KEY" "$BASE/search?q=attention&k=8"`}</CodeBlock>
        <p className="text-xs text-stone-500">
          전체 레퍼런스(모든 엔드포인트·응답·에러 코드)는 저장소의{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">docs/rest-api.md</code>에 있습니다.
        </p>
      </Section>

      <Section title="인증 경계 — 무엇이 API 키로 되고 무엇이 안 되나">
        <p className="text-sm text-stone-600">
          &ldquo;인증 경계 = 비용 경계&rdquo;. 내부 AI(Gemini)를 대량 소비하는 라우트는 <strong>웹 UI의 쿠키 세션 전용</strong>이라
          API 키로는 호출할 수 없습니다. 외부 경로에서는 primitive로 직접 작성하세요.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-stone-200 p-3">
            <div className="mb-1 text-xs font-semibold text-emerald-700">API 키(Bearer)로 가능</div>
            <p className="text-xs text-stone-600 leading-relaxed">
              페이지 조회/작성/삭제, 원문 저장/조회, 하이브리드 검색, 온톨로지 조회·카테고리 매칭, 기계 점검 lint, 잡 상태 폴링
            </p>
          </div>
          <div className="rounded-md border border-stone-200 p-3">
            <div className="mb-1 text-xs font-semibold text-amber-700">세션 전용 (API 키 불가)</div>
            <p className="text-xs text-stone-600 leading-relaxed">
              <code className="rounded bg-stone-100 px-1 py-0.5">POST /ingest</code>(내부 AI ingest),{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5">/query</code>,{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5">/reindex</code>,{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5">/lint {`{deep:true}`}</code> — 웹 UI에서만
            </p>
          </div>
        </div>
      </Section>

      <p className="text-xs text-stone-400">
        참고 파일 — 스킬: <code className="rounded bg-stone-100 px-1 py-0.5">skills/wiki-ingest/SKILL.md</code> ·
        MCP: <code className="rounded bg-stone-100 px-1 py-0.5">mcp/server.mjs</code> ·
        REST: <code className="rounded bg-stone-100 px-1 py-0.5">docs/rest-api.md</code>
      </p>
    </main>
  );
}
