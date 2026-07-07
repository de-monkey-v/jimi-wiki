"use client";
import Link from "next/link";
import { useWikiActions } from "./WikiActions";

/** 위키 홈의 ingest·새페이지 진입 카드. 페이지 이동 없이 모달을 연다(새페이지는 /new 폴백). */
export function HomeActions({ slug }: { slug: string }) {
  const actions = useWikiActions();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col justify-between rounded-lg border p-4">
        <div>
          <h2 className="font-semibold">소스 편입 (Ingest)</h2>
          <p className="mt-1 text-xs text-gray-400">URL이나 텍스트를 주면 LLM이 읽고 노트·개념 페이지로 정리합니다.</p>
        </div>
        <button
          type="button"
          onClick={() => actions?.openIngest()}
          className="mt-3 inline-block w-fit rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-700"
        >
          소스 편입 열기
        </button>
      </div>

      <div className="flex flex-col justify-between rounded-lg border p-4">
        <div>
          <h2 className="font-semibold">새 페이지 (수동)</h2>
          <p className="mt-1 text-xs text-gray-400">제목·종류·카테고리를 정해 빈 페이지를 만들고 바로 편집합니다.</p>
        </div>
        <Link
          href={`/wikis/${slug}/new`}
          onClick={(e) => {
            if (actions) {
              e.preventDefault();
              actions.openNewPage();
            }
          }}
          className="mt-3 inline-block w-fit rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-700"
        >
          새 페이지 만들기 →
        </Link>
      </div>
    </div>
  );
}
