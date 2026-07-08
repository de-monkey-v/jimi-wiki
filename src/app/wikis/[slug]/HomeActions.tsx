"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useWikiActions } from "./WikiActions";

/** 위키 홈의 ingest·새페이지 진입 카드. 페이지 이동 없이 모달을 연다(새페이지는 /new 폴백). */
export function HomeActions({ slug }: { slug: string }) {
  const t = useTranslations("WikisSlugHomeActions");
  const actions = useWikiActions();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col justify-between rounded-lg border p-4">
        <div>
          <h2 className="font-semibold">{t("ingestTitle")}</h2>
          <p className="mt-1 text-xs text-gray-400">{t("ingestDesc")}</p>
        </div>
        <button
          type="button"
          onClick={() => actions?.openIngest()}
          className="mt-3 inline-block w-fit rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-700"
        >
          {t("ingestOpen")}
        </button>
      </div>

      <div className="flex flex-col justify-between rounded-lg border p-4">
        <div>
          <h2 className="font-semibold">{t("newPageTitle")}</h2>
          <p className="mt-1 text-xs text-gray-400">{t("newPageDesc")}</p>
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
          {t("newPageCreate")}
        </Link>
      </div>
    </div>
  );
}
