import Link from "next/link";
import type { ReactNode } from "react";
import { PageNav } from "./PageNav";
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
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      {crumb}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{title}</h1>
        {editHref && (
          <Link href={editHref} className="rounded border px-3 py-1 text-sm hover:bg-stone-50">
            편집
          </Link>
        )}
      </div>

      {/* 소스 노트: 원문 provenance 카드(합성/관계는 본문에 없음) */}
      {isNote && provenance && <ProvenanceCard title={provenance.title} href={provenance.href} url={provenance.url} />}

      {/* 파생 페이지: 출처(원본) 카드 — 이 지식이 유래한 원본으로 가는 길 */}
      {!isNote && sources && sources.length > 0 && <SourcesPanel sources={sources} hrefFor={sourceHrefFor} />}

      {isEmpty ? (
        <p className="text-stone-400">{emptyText}</p>
      ) : (
        <article className="wiki-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}

      <PageNav prev={prev} next={next} hrefFor={hrefFor} />

      {localGraph}

      {/* note: 백링크만("이 소스에서 파생된 문서"). 파생 페이지: 아웃링크+백링크 관련 문서 패널 */}
      {isNote ? (
        <BacklinksPanel
          heading="이 소스에서 파생된 문서"
          emptyText="아직 이 소스에서 파생된 문서가 없습니다."
          items={backlinks}
          hrefFor={hrefFor}
        />
      ) : (
        <RelatedPanel outlinks={outlinks ?? []} backlinks={backlinks} hrefFor={hrefFor} />
      )}
    </main>
  );
}
