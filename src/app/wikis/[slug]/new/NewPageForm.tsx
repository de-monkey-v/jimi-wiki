"use client";
import { useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { createPageAction } from "../../actions";
import { MANUAL_KIND_OPTIONS } from "@/lib/kinds";

type WikiKind = "personal" | "project" | "channel";
export type CategoryOption = { slug: string; label: string; itemCount: number };

// 위키 종류별 빠른 카테고리. 프로젝트 위키의 문서 니즈는 kind가 아니라 category로 흡수한다.
const KIND_QUICK_CATS: Record<WikiKind, string[]> = {
  personal: [],
  project: ["decisions", "meetings", "specs"],
  channel: [],
};

function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("WikisSlugNewNewPageForm");
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-stone-900 px-5 py-2 text-white hover:bg-stone-700 disabled:opacity-50"
    >
      {pending ? t("submitting") : t("create")}
    </button>
  );
}

/**
 * 카테고리 콤보박스. 전체 카테고리 목록을 클라이언트에서 부분일치 필터링(서버 왕복 없음 → 레이스·스테일 없음).
 * WAI-ARIA combobox: DOM 포커스는 input에 고정, 활성 옵션은 aria-activedescendant로 지시.
 */
function CategoryPicker({ categories, quickCats, initialValue }: { categories: CategoryOption[]; quickCats: string[]; initialValue?: string }) {
  const t = useTranslations("WikisSlugNewNewPageForm");
  const [value, setValue] = useState(initialValue ?? "");
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
        {t("categoryLabel")} <span className="font-normal text-stone-400">{t("categoryLabelHint")}</span>
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
        placeholder={t("categoryPlaceholder")}
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
                <span className="text-blue-700">{t("createCategory", { slug: o.slug })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-stone-400">{t("reuseHint")}</p>
    </div>
  );
}

/** 새 페이지 수동 생성 폼(클라이언트). kind는 concept/entity로 제한, 카테고리는 자동완성, 위키 종류별 안내. */
export function NewPageForm({
  wikiSlug,
  wikiKind,
  categories,
  presetCategory,
  presetKind,
}: {
  wikiSlug: string;
  wikiKind: WikiKind;
  categories: CategoryOption[];
  presetCategory?: string; // 폴더 "+"에서 열면 그 폴더 경로로 카테고리 프리필
  presetKind?: string; // 개인 노트 생성 등 기본 kind 지정
}) {
  const t = useTranslations("WikisSlugNewNewPageForm");
  const tk = useTranslations("Kinds");
  const quickCats = KIND_QUICK_CATS[wikiKind];
  const [kind, setKind] = useState(presetKind ?? "concept"); // controlled — personal 선택 시 보안 경고 노출
  return (
    <form action={createPageAction} className="space-y-4">
      <input type="hidden" name="wikiSlug" value={wikiSlug} />

      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-500">
        {t(`kindHint.${wikiKind}`)}
      </p>

      <div>
        <label htmlFor="new-title" className="mb-1 block text-sm font-medium text-stone-600">
          {t("titleLabel")}
        </label>
        <input
          id="new-title"
          name="title"
          required
          autoFocus
          placeholder={t("titlePlaceholder")}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      <div>
        <label htmlFor="new-kind" className="mb-1 block text-sm font-medium text-stone-600">
          {t("kindLabel")}
        </label>
        <select id="new-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded border px-3 py-2">
          {MANUAL_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {tk(`${o.value}Option`)}
            </option>
          ))}
        </select>
        {kind === "personal" && (
          <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">⚠ {tk("personalWarning")}</p>
        )}
        <p className="mt-1 text-xs text-stone-400">
          {t.rich("ingestHint", {
            link: (chunks) => (
              <Link href={`/wikis/${wikiSlug}`} className="text-blue-600 hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>

      <CategoryPicker categories={categories} quickCats={quickCats} initialValue={presetCategory} />

      <div>
        <label htmlFor="new-body" className="mb-1 block text-sm font-medium text-stone-600">
          {t("bodyLabel")} <span className="font-normal text-stone-400">{t("bodyLabelHint")}</span>
        </label>
        <textarea
          id="new-body"
          name="body"
          rows={16}
          placeholder={t("bodyPlaceholder")}
          className="w-full rounded border px-3 py-2 font-mono text-sm"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <SubmitButton />
        <Link href={`/wikis/${wikiSlug}`} className="text-sm text-gray-500 hover:underline">
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
}
