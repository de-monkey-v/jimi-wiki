import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUserId } from "@/lib/session";
import { getWikiForUser } from "@/lib/wiki";
import { createPageAction } from "../../actions";

/** 새 페이지 수동 생성 전용 화면. 만들면 바로 편집 화면으로 이동한다. */
export default async function NewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const userId = await getCurrentUserId();
  const wiki = await getWikiForUser(userId, slug);
  if (!wiki) notFound();
  if (wiki.role === "viewer") redirect(`/wikis/${encodeURIComponent(slug)}`); // 읽기 전용은 생성 불가

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <div className="mb-1 text-sm text-gray-400">
        <Link href="/wikis" className="hover:underline">내 위키</Link> /{" "}
        <Link href={`/wikis/${slug}`} className="hover:underline">{wiki.title}</Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold">새 페이지</h1>
      <p className="mb-6 text-sm text-gray-500">
        직접 작성하는 페이지입니다. 원문(URL·텍스트)을 정리해 넣으려면 위키 홈의 소스 편입(Ingest)을 사용하세요.
      </p>

      <form action={createPageAction} className="space-y-4">
        <input type="hidden" name="wikiSlug" value={slug} />
        <div>
          <label htmlFor="new-title" className="mb-1 block text-sm font-medium text-stone-600">제목</label>
          <input id="new-title" name="title" required autoFocus placeholder="페이지 제목" className="w-full rounded border px-3 py-2" />
        </div>
        <div>
          <label htmlFor="new-kind" className="mb-1 block text-sm font-medium text-stone-600">종류</label>
          <select id="new-kind" name="kind" defaultValue="concept" className="w-full rounded border px-3 py-2">
            <option value="concept">개념 — 아이디어, 패턴, 이론</option>
            <option value="entity">개체 — 인물, 조직, 도구, 제품</option>
            <option value="answer">답변 — 비교, 분석, 종합</option>
            <option value="note">소스 노트 — 원문 요약</option>
            <option value="meta">메타 — 위키 자체에 대한 문서</option>
          </select>
        </div>
        <div>
          <label htmlFor="new-category" className="mb-1 block text-sm font-medium text-stone-600">
            카테고리 <span className="font-normal text-stone-400">(선택 · 예: ai/concepts)</span>
          </label>
          <input id="new-category" name="category" placeholder="비워두면 미분류" className="w-full rounded border px-3 py-2" />
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button type="submit" className="rounded bg-stone-900 px-5 py-2 text-white hover:bg-stone-700">
            만들고 편집 →
          </button>
          <Link href={`/wikis/${slug}`} className="text-sm text-gray-500 hover:underline">취소</Link>
        </div>
      </form>
    </main>
  );
}
