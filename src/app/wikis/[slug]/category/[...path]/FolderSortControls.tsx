"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { setFolderSortPreferenceAction } from "@/app/wikis/actions";
import {
  FOLDER_SORT_SELECTIONS,
  type FolderSortMode,
  type FolderSortSelection,
} from "@/lib/folder-sort";

export function FolderSortControls({
  wikiSlug,
  category,
  storedMode,
  effectiveMode,
}: {
  wikiSlug: string;
  category: string;
  storedMode: FolderSortMode | null;
  effectiveMode: FolderSortMode;
}) {
  const t = useTranslations("FolderSortControls");
  const router = useRouter();
  const descriptionId = useId();
  const [selected, setSelected] = useState<FolderSortSelection>(storedMode ?? "auto");
  const [pendingSelection, setPendingSelection] = useState<FolderSortSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const select = (selection: FolderSortSelection) => {
    if (pending || selection === selected) return;
    setError(null);
    setPendingSelection(selection);
    startTransition(async () => {
      try {
        const saved = await setFolderSortPreferenceAction(wikiSlug, category, selection);
        setSelected(saved);
        router.refresh();
      } catch {
        setError(t("saveError"));
      } finally {
        setPendingSelection(null);
      }
    });
  };

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5" aria-busy={pending}>
        <span className="text-xs font-medium text-stone-400">{t("label")}</span>
        <div role="group" aria-label={t("label")} aria-describedby={descriptionId} className="flex flex-wrap justify-end gap-1">
          {FOLDER_SORT_SELECTIONS.map((selection) => {
            const active = selection === selected;
            const waiting = pending && selection === pendingSelection;
            return (
              <button
                key={selection}
                type="button"
                aria-pressed={active}
                disabled={pending}
                onClick={() => select(selection)}
                className={`rounded-md border px-2 py-1 text-xs font-medium transition-[background-color,border-color,color,box-shadow,transform] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-55 ${
                  active
                    ? "border-indigo-600 bg-indigo-600 text-white shadow-sm hover:bg-indigo-700"
                    : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-100 active:bg-stone-200"
                }`}
              >
                {t(`option.${selection}`)}
                {waiting ? <span aria-hidden="true" className="ml-1">…</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <span id={descriptionId} className="sr-only">
        {selected === "auto"
          ? t("autoEffective", { mode: t(`option.${effectiveMode}`) })
          : t("selected", { mode: t(`option.${selected}`) })}
      </span>
      <span aria-live="polite" className="sr-only">{pending ? t("saving") : ""}</span>
      {error ? <p role="alert" className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
