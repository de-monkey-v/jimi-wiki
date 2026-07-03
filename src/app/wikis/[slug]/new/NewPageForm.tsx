"use client";
import { useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { createPageAction } from "../../actions";
import { MANUAL_KIND_OPTIONS } from "@/lib/kinds";

type WikiKind = "personal" | "project" | "channel";
export type CategoryOption = { slug: string; label: string; itemCount: number };

// 위키 종류별 폼 안내·빠른 카테고리. 프로젝트 위키의 문서 니즈는 kind가 아니라 category로 흡수한다.
const KIND_GUIDE: Record<WikiKind, { hint: string; quickCats: string[] }> = {
  personal: { hint: "개인 지식 위키 — 개념과 개체를 자유롭게 정리하세요.", quickCats: [] },
  project: {
    hint: "프로젝트 위키 — 회의록·결정·스펙은 카테고리로 묶으면 찾기 쉽습니다.",
    quickCats: ["decisions", "meetings", "specs"],
  },
  channel: { hint: "공개 채널 — 다른 사람이 둘러봅니다. 제목과 분류를 명확히.", quickCats: [] },
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-stone-900 px-5 py-2 text-white hover:bg-stone-700 disabled:opacity-50"
    >
      {pending ? "만드는 중…" : "만들기"}
    </button>
  );
}

/**
 * 카테고리 콤보박스. 전체 카테고리 목록을 클라이언트에서 부분일치 필터링(서버 왕복 없음 → 레이스·스테일 없음).
 * WAI-ARIA combobox: DOM 포커스는 input에 고정, 활성 옵션은 aria-activedescendant로 지시.
 */
function CategoryPicker({ categories, quickCats }: { categories: CategoryOption[]; quickCats: string[] }) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const q = value.trim();
  const ql = q.toLowerCase();
  // 동기 파생: value가 바뀌면 즉시 재계산되어 active(-1 리셋)와 항상 일관 (스테일/레이스 없음)
  const byCount = (a: CategoryOption, b: CategoryOption) => (b.itemCount ?? 0) - (a.itemCount ?? 0);
  const filtered = (
    q ? categories.filter((c) => c.slug.toLowerCase().includes(ql) || c.label.toLowerCase().includes(ql)) : categories
  )
    .slice()
    .sort(byCount)
    .slice(0, 8);
  const exactExists = q ? categories.some((c) => c.slug.toLowerCase() === ql) : false;
  const showCreate = q.length > 0 && !exactExists;
  const options: { kind: "existing" | "create"; slug: string; itemCount?: number }[] = [
    ...filtered.map((c) => ({ kind: "existing" as const, slug: c.slug, itemCount: c.itemCount })),
    ...(showCreate ? [{ kind: "create" as const, slug: q }] : []),
  ];
  const showList = open && options.length > 0;
  const activeId = active >= 0 && active < options.length ? `${listId}-opt-${active}` : undefined;

  function choose(slug: string) {
    setValue(slug);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") return setOpen(false);
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) return setOpen(true);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && active >= 0 && active < options.length) {
      e.preventDefault();
      choose(options[active].slug);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <label htmlFor="new-category" className="mb-1 block text-sm font-medium text-stone-600">
        카테고리 <span className="font-normal text-stone-400">(선택 · 사이드바 폴더)</span>
      </label>
      {/* 서버 액션에 실제로 전달되는 값 */}
      <input type="hidden" name="category" value={value} />
      <input
        id="new-category"
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // 컨테이너 밖으로 포커스 이탈 시 닫기(Tab 이탈 포함). 옵션은 onMouseDown preventDefault라 blur 없음.
          if (!boxRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
        onKeyDown={onKeyDown}
        placeholder="비워두면 미분류 · 입력하면 기존 카테고리를 추천"
        className="w-full rounded border px-3 py-2"
      />
      {quickCats.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {quickCats.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => choose(c)}
              className="rounded-full border border-stone-200 px-2 py-0.5 text-xs text-stone-500 hover:border-blue-400 hover:text-blue-700"
            >
              {c}/
            </button>
          ))}
        </div>
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
        >
          {options.map((o, i) => (
            <li
              key={`${o.kind}:${o.slug}`}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o.slug);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm ${
                i === active ? "bg-stone-100" : ""
              }`}
            >
              {o.kind === "existing" ? (
                <>
                  <span className="text-stone-700">{o.slug}</span>
                  {o.itemCount ? <span className="text-xs text-stone-400">{o.itemCount}</span> : null}
                </>
              ) : (
                <span className="text-blue-700">＋ 새 카테고리 만들기: {o.slug}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-stone-400">기존 카테고리 재사용을 권장합니다. 저장 시 표기가 자동 정규화됩니다.</p>
    </div>
  );
}

/** 새 페이지 수동 생성 폼(클라이언트). kind는 concept/entity로 제한, 카테고리는 자동완성, 위키 종류별 안내. */
export function NewPageForm({
  wikiSlug,
  wikiKind,
  categories,
}: {
  wikiSlug: string;
  wikiKind: WikiKind;
  categories: CategoryOption[];
}) {
  const guide = KIND_GUIDE[wikiKind];
  return (
    <form action={createPageAction} className="space-y-4">
      <input type="hidden" name="wikiSlug" value={wikiSlug} />

      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-500">{guide.hint}</p>

      <div>
        <label htmlFor="new-title" className="mb-1 block text-sm font-medium text-stone-600">
          제목
        </label>
        <input
          id="new-title"
          name="title"
          required
          autoFocus
          placeholder="페이지 제목"
          className="w-full rounded border px-3 py-2"
        />
      </div>

      <div>
        <label htmlFor="new-kind" className="mb-1 block text-sm font-medium text-stone-600">
          종류
        </label>
        <select id="new-kind" name="kind" defaultValue="concept" className="w-full rounded border px-3 py-2">
          {MANUAL_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-stone-400">
          원문을 정리한 소스 노트는{" "}
          <Link href={`/wikis/${wikiSlug}`} className="text-blue-600 hover:underline">
            소스 편입(Ingest)
          </Link>
          으로, AI 답변 저장은 채팅의 &lsquo;위키에 저장&rsquo;으로 만들어집니다.
        </p>
      </div>

      <CategoryPicker categories={categories} quickCats={guide.quickCats} />

      <div>
        <label htmlFor="new-body" className="mb-1 block text-sm font-medium text-stone-600">
          내용 <span className="font-normal text-stone-400">(선택 · 나중에 편집 가능)</span>
        </label>
        <textarea
          id="new-body"
          name="body"
          rows={16}
          placeholder="마크다운으로 작성. 위키링크는 [[페이지-슬러그]] 또는 [[슬러그|표시명]]"
          className="w-full rounded border px-3 py-2 font-mono text-sm"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <SubmitButton />
        <Link href={`/wikis/${wikiSlug}`} className="text-sm text-gray-500 hover:underline">
          취소
        </Link>
      </div>
    </form>
  );
}
