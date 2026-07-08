"use client";

import { useState, useTransition } from "react";
import { useLocale } from "next-intl";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/locales";

// 우상단 고정 언어 스위처. 쿠키 set은 부모(root layout)의 server action이 처리하고,
// 쿠키가 바뀌면 Next가 트리를 자동 재렌더한다(router.refresh 불필요).
export default function LocaleSwitcher({
  changeLocaleAction,
}: {
  changeLocaleAction: (locale: Locale) => Promise<void>;
}) {
  const current = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function pick(locale: Locale) {
    setOpen(false);
    if (locale === current) return;
    startTransition(async () => {
      await changeLocaleAction(locale);
    });
  }

  return (
    <div className="fixed top-3 right-3 z-50 text-sm">
      {open && (
        // 바깥 클릭 닫기용 투명 백드롭
        <button
          aria-hidden
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      <div className="relative z-50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={pending}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md border border-black/10 bg-white/90 px-2.5 py-1.5 font-medium text-neutral-700 shadow-sm backdrop-blur transition hover:bg-white disabled:opacity-60 dark:border-white/15 dark:bg-neutral-800/90 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          <span aria-hidden>🌐</span>
          <span>{LOCALE_LABELS[current]}</span>
          <span aria-hidden className="text-xs opacity-60">▾</span>
        </button>
        {open && (
          <ul
            role="listbox"
            className="absolute right-0 mt-1 min-w-[8rem] overflow-hidden rounded-md border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-neutral-800"
          >
            {LOCALES.map((loc) => (
              <li key={loc}>
                <button
                  type="button"
                  role="option"
                  aria-selected={loc === current}
                  onClick={() => pick(loc)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
                    loc === current ? "font-semibold text-blue-600 dark:text-blue-400" : "text-neutral-700 dark:text-neutral-200"
                  }`}
                >
                  {LOCALE_LABELS[loc]}
                  {loc === current && <span aria-hidden>✓</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
