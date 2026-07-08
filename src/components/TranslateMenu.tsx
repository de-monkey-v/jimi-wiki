"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/locales";
import type { LangCode } from "@/lib/lang";

// 페이지 리딩 뷰의 온디맨드 번역 컨트롤. ?lang=<locale> 쿼리로 서버 렌더가 (캐시된) 번역을 표시한다.
// current=null 이면 원문 보기 상태. 원문 언어(pageLang)로의 번역은 선택지에서 제외.
export default function TranslateMenu({ current, pageLang }: { current: Locale | null; pageLang: LangCode }) {
  const t = useTranslations("PageTranslate");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);

  function go(loc: Locale | null) {
    setOpen(false);
    const sp = new URLSearchParams(params.toString());
    if (loc) sp.set("lang", loc);
    else sp.delete("lang");
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const targets = LOCALES.filter((l) => l !== pageLang);

  return (
    <div className="relative flex items-center gap-1 text-sm">
      {current && <span className="text-xs text-amber-600 dark:text-amber-500">{t("machineTranslated")}</span>}
      {open && (
        <button aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? t("machineTranslated") : t("translate")}
        className="z-50 flex items-center gap-1 rounded border border-stone-200 px-2.5 py-1 text-stone-600 hover:bg-stone-50 dark:border-white/15 dark:text-stone-300 dark:hover:bg-neutral-800"
      >
        <span aria-hidden>🌐</span>
        <span>{current ? LOCALE_LABELS[current] : t("translate")}</span>
        <span aria-hidden className="text-xs opacity-60">▾</span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 min-w-[9rem] overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-neutral-800"
        >
          {current && (
            <li>
              <button
                type="button"
                onClick={() => go(null)}
                className="block w-full px-3 py-1.5 text-left text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-neutral-700"
              >
                {t("showOriginal")}
              </button>
            </li>
          )}
          {targets.map((loc) => (
            <li key={loc}>
              <button
                type="button"
                role="option"
                aria-selected={loc === current}
                onClick={() => go(loc)}
                className={`block w-full px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-neutral-700 ${
                  loc === current ? "font-semibold text-blue-600 dark:text-blue-400" : "text-stone-700 dark:text-stone-200"
                }`}
              >
                {LOCALE_LABELS[loc]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
