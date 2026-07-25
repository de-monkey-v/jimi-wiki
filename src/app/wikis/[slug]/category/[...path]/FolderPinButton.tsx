"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toggleFolderPinAction } from "@/app/wikis/actions";

/** 폴더(category) 고정 토글. 사이드바 "고정됨"에 폴더를 올려 자주 여는 폴더를 한 클릭. PinButton 미러. */
export function FolderPinButton({ wikiSlug, category, pinned: initial }: { wikiSlug: string; category: string; pinned: boolean }) {
  const t = useTranslations("FolderPinButton");
  const [pinned, setPinned] = useState(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={pinned}
      onClick={() =>
        start(async () => {
          const next = await toggleFolderPinAction(wikiSlug, category);
          setPinned(next);
          router.refresh();
        })
      }
      className="btn-secondary btn-compact shrink-0"
    >
      <span className={pinned ? "text-amber-500" : "text-stone-400"}>{pinned ? "★" : "☆"}</span>
      <span className="ml-1 text-xs text-stone-500">{pinned ? t("pinned") : t("pin")}</span>
    </button>
  );
}
