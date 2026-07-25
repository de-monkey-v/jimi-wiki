"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { togglePinAction } from "@/app/wikis/actions";

/** 페이지 고정(개인 즐겨찾기) 토글. 낙관적 로컬 상태 + router.refresh로 사이드바 핀 목록 갱신. */
export function PinButton({ wikiSlug, pageSlug, pinned: initial }: { wikiSlug: string; pageSlug: string; pinned: boolean }) {
  const t = useTranslations("PinButton");
  const [pinned, setPinned] = useState(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={pinned}
      aria-label={pinned ? t("unpin") : t("pin")}
      title={pinned ? t("unpin") : t("pin")}
      onClick={() =>
        start(async () => {
          const next = await togglePinAction(wikiSlug, pageSlug);
          setPinned(next);
          router.refresh();
        })
      }
      className="btn-secondary btn-compact"
    >
      <span className={pinned ? "text-amber-500" : "text-stone-400"}>{pinned ? "★" : "☆"}</span>
    </button>
  );
}
