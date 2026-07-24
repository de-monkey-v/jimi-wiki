import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PageNav } from "./PageNav";
import { WikiArticle } from "./WikiArticle";
import { ProvenanceCard } from "./reading/ProvenanceCard";
import { BacklinksPanel } from "./reading/BacklinksPanel";
import { RelatedPanel } from "./reading/RelatedPanel";
import { SourcesPanel } from "./reading/SourcesPanel";

type NavItem = { slug: string; title: string } | null;
type Provenance = { title: string; href?: string; url?: string | null } | null;
type SourceRef = { slug: string; title: string; url?: string | null };

/** 비공개 페이지 뷰 · 공개 읽기(PublicWikiView) 공용 읽기 페인. kind에 따라 순수성 분기. */
export function ReadingPane({
  title,
  html,
  isEmpty,
  emptyText,
  isNote = false,
  provenance = null,
  sources,
  sourceHrefFor,
  backlinks,
  outlinks,
  prev,
  next,
  hrefFor,
  crumb,
  editHref,
  localGraph,
  translateControl,
  pinControl,
  create,
  selection,
  headerMeta,
  notice,
  controls,
}: {
  title: string;
  html: string;
  isEmpty: boolean;
  emptyText: string;
  isNote?: boolean;
  provenance?: Provenance;
  sources?: SourceRef[];
  sourceHrefFor?: (slug: string) => string;
  backlinks: { slug: string; title: string }[];
  outlinks?: { slug: string; title: string }[];
  prev: NavItem;
  next: NavItem;
  hrefFor: (slug: string) => string;
  crumb?: ReactNode;
  editHref?: string;
  localGraph?: ReactNode;
  translateControl?: ReactNode;
  pinControl?: ReactNode; // 개인 즐겨찾기 별 토글(비공개 뷰만)
  create?: { wikiSlug: string; category: string | null }; // 있으면 미해결 [[link]] 클릭 → 생성(비공개 쓰기 뷰만)
  selection?: { pageSlug: string; canWrite: boolean }; // 있으면 본문 텍스트 선택 툴바 활성(비공개 뷰만)
  headerMeta?: ReactNode; // origin/modelAccess/version 등 비공개 뷰 전용 헤더 메타
  notice?: ReactNode; // archive 등 현재 문서 상태 안내
  controls?: ReactNode; // 비공개 화면의 정책·수명주기 제어
}) {
  const t = useTranslations("ReadingPane");
  return (
    <main className="mx-auto reading-measure px-6 py-10">
      {crumb}
      {notice && <div className="mt-3">{notice}</div>}
      <div className="mb-6 mt-3">
        {headerMeta && <div className="mb-2">{headerMeta}</div>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="min-w-0 break-words text-2xl font-bold">{title}</h1>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {pinControl}
            {translateControl}
            {editHref && (
              <Link
                href={editHref}
                className="rounded border px-3 py-1 text-sm hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {t("edit")}
              </Link>
            )}
          </div>
        </div>
      </div>

      {controls && <div className="mb-6">{controls}</div>}

      {/* 소스 노트: 원문 provenance 카드(합성/관계는 본문에 없음) */}
      {isNote && provenance && <ProvenanceCard title={provenance.title} href={provenance.href} url={provenance.url} />}

      {/* 파생 페이지: 출처(원본) 카드 — 이 지식이 유래한 원본으로 가는 길 */}
      {!isNote && sources && sources.length > 0 && <SourcesPanel sources={sources} hrefFor={sourceHrefFor} />}

      {isEmpty ? (
        <p className="text-stone-400">{emptyText}</p>
      ) : (
        // create 유무와 무관하게 클라이언트 렌더러 경유 — 위키링크 hover 미리보기 위임을 한 곳에 둔다.
        // 공개 뷰는 HoverPreviewProvider 밖이라 미리보기가 자동으로 무동작이다.
        <WikiArticle html={html} create={create} selection={selection} />
      )}

      <PageNav prev={prev} next={next} hrefFor={hrefFor} />

      {localGraph}

      {/* note: 백링크만("이 소스에서 파생된 문서"). 파생 페이지: 아웃링크+백링크 관련 문서 패널 */}
      {isNote ? (
        <BacklinksPanel
          heading={t("derivedHeading")}
          emptyText={t("derivedEmpty")}
          items={backlinks}
          hrefFor={hrefFor}
        />
      ) : (
        <RelatedPanel outlinks={outlinks ?? []} backlinks={backlinks} hrefFor={hrefFor} />
      )}
    </main>
  );
}
