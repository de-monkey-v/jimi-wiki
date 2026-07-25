import Link from "next/link";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
  const t = await getTranslations("DocsPage");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

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
  const t = await getTranslations("DocsPage");
  const { wiki } = await searchParams;
  const slug = sanitizeSlug(wiki);
  const SLUG = slug ?? "<위키-slug>";
  const BASE = "http://localhost:3007"; // 배포 환경에서는 호스트만 바뀐다

  const code = (chunks: React.ReactNode) => (
    <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">{chunks}</code>
  );
  const code2 = (chunks: React.ReactNode) => (
    <code className="rounded bg-stone-100 px-1 py-0.5">{chunks}</code>
  );
  const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;

  return (
    <main className="mx-auto compact-measure px-6 py-10 space-y-6">
      <div>
        <Link href={slug ? `/wikis/${slug}` : "/wikis"} className="text-sm text-gray-400 hover:underline">
          ← {slug ? t("backToWiki") : t("backToMyWikis")}
        </Link>
        <h1 className="text-2xl font-bold mt-1">{t("title")}</h1>
        <p className="text-sm text-gray-500">
          {t.rich("intro", { strong })}
          {slug ? (
            <> {t.rich("introSlugFilled", { code, slug })}</>
          ) : (
            <> {t.rich("introSlugPlaceholder", { code, slug: SLUG })}</>
          )}
        </p>
      </div>

      <Section title={t("section1Title")}>
        <p className="text-sm text-stone-600">
          {t.rich("section1.auth", { code, header: "Authorization: Bearer <키>" })}
        </p>
        <ul className="list-disc pl-5 text-sm text-stone-600 space-y-1">
          <li>
            {t.rich("section1.li1", {
              link: (chunks) => (
                <Link href="/keys" className="text-stone-800 underline hover:text-stone-950">
                  {chunks}
                </Link>
              ),
            })}
          </li>
          <li>{t.rich("section1.li2", { strong })}</li>
          <li>{t.rich("section1.li3", { code })}</li>
        </ul>
      </Section>

      <Section title={t("section2Title")}>
        <p className="text-sm text-stone-600">{t.rich("section2.intro", { code })}</p>
        <p className="text-xs font-semibold text-stone-500">{t("section2.claudeLabel")}</p>
        <CodeBlock>{`claude mcp add --scope local jimi-wiki \\
  -e JIMI_WIKI_URL=${BASE} \\
  -e JIMI_WIKI_API_KEY=<발급받은-키> \\
  -e JIMI_WIKI_SLUG=${SLUG} \\
  -- node <repo>/mcp/server.mjs`}</CodeBlock>
        <p className="text-xs font-semibold text-stone-500">{t("section2.hermesLabel")}</p>
        <CodeBlock>{`# ~/.hermes/.env
JIMI_WIKI_PERSONAL_KEY=jw_...

# ~/.hermes/config.yaml
mcp_servers:
  jimi-wiki:
    command: "node"
    args: ["<repo>/mcp/server.mjs"]
    env:
      JIMI_WIKI_URL: "${BASE}"
      JIMI_WIKI_API_KEY: "\${JIMI_WIKI_PERSONAL_KEY}"
      JIMI_WIKI_SLUG: "${SLUG}"`}</CodeBlock>
        <p className="text-sm text-stone-600">{t("section2.toolsLabel")}</p>
        <p className="text-sm text-stone-600">
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">search_wiki</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">list_pages</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">read_page</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">write_page</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">preserve_url/text</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">curate_url/text/source</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">record_document/worklog</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">search_documents</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">append_document</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">save/list/promote_saved_link</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">create_source</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">list_sources</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">read_source</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">get_ontology</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">match_category</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">run_lint</code>,{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-xs">list_trash / trash_* / restore_*</code>
        </p>
      </Section>

      <Section title={t("section3Title")}>
        <p className="text-sm text-stone-600">{t.rich("section3.p1", { code, strong })}</p>
        <p className="text-sm text-stone-600">{t.rich("section3.p2", { code })}</p>
        <p className="text-sm text-stone-600">{t("section3.bundleLabel")}</p>
        <ul className="list-disc pl-5 text-sm text-stone-600 space-y-1">
          <li>{t.rich("section3.li1", { code })}</li>
          <li>{t.rich("section3.li2", { code })}</li>
          <li>{t.rich("section3.li3", { code })}</li>
          <li>{t.rich("section3.li4", { code })}</li>
        </ul>
      </Section>

      <Section title={t("section4Title")}>
        <p className="text-sm text-stone-600">
          {t.rich("section4.baseUrl", { code, url: `${BASE}/api/wikis/${SLUG}` })}
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

# 원문만 보존(생성형 큐레이션 없음)
curl -sX POST "$BASE/ingest" -H "Authorization: Bearer $KEY" \\
  -H 'content-type: application/json' -d '{"url":"https://...","mode":"preserve"}'

# 독립 작업 문서 기록
curl -sX POST "$BASE/documents" -H "Authorization: Bearer $KEY" \\
  -H 'content-type: application/json' \\
  -d '{"title":"작업 기록","body":"...","type":"worklog","documentAt":"2026-07-21T12:30:00+09:00"}'

# 전체 검색은 지식/문서를 그룹으로 반환
curl -sH "Authorization: Bearer $KEY" "$BASE/search?q=attention&scope=all&k=8"`}</CodeBlock>
        <p className="text-xs text-stone-500">{t.rich("section4.fullRef", { code })}</p>
      </Section>

      <Section title={t("sectionAuthTitle")}>
        <p className="text-sm text-stone-600">{t.rich("auth.intro", { strong })}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-stone-200 p-3">
            <div className="mb-1 text-xs font-semibold text-emerald-700">{t("auth.card1Title")}</div>
            <p className="text-xs text-stone-600 leading-relaxed">{t("auth.card1Body")}</p>
          </div>
          <div className="rounded-md border border-stone-200 p-3">
            <div className="mb-1 text-xs font-semibold text-amber-700">{t("auth.card2Title")}</div>
            <p className="text-xs text-stone-600 leading-relaxed">
              {t.rich("auth.card2Body", { code: code2, lint: "/lint {deep:true}" })}
            </p>
          </div>
        </div>
      </Section>

      <p className="text-xs text-stone-400">{t.rich("footer", { code: code2 })}</p>
    </main>
  );
}
