"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useWikiActions } from "./WikiActions";

/** 위키 홈 하단의 ingest·새페이지 진입 버튼(읽기 대시보드라 소형). 페이지 이동 없이 모달을 연다(새페이지는 /new 폴백). */
export function HomeActions({ slug }: { slug: string }) {
  const t = useTranslations("WikisSlugHomeActions");
  const actions = useWikiActions();
  return (
    <>
      <button
        type="button"
        onClick={() => actions?.openIngest()}
        title={t("ingestDesc")}
        className="btn-secondary text-sm"
      >
        {t("ingestOpen")}
      </button>
      <Link
        href={`/wikis/${slug}/new`}
        title={t("newPageDesc")}
        onClick={(e) => {
          if (actions) {
            e.preventDefault();
            actions.openNewPage();
          }
        }}
        className="btn-secondary text-sm"
      >
        {t("newPageCreate")}
      </Link>
    </>
  );
}
