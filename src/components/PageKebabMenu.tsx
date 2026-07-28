"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQuickNav } from "@/app/wikis/[slug]/QuickNav";
import { trashPageFromMenuAction } from "@/app/wikis/[slug]/knowledge-controls-actions";
import { KebabMenu, type KebabMenuItem } from "@/components/ui/KebabMenu";

/**
 * 페이지 행/헤더 공용 케밥(⋮) 메뉴 — 폴더 이동(personal)과 휴지통 이동을 노출한다.
 * canTrash는 서버에서 canWrite && isPageTrashEligible()로 판정해 내려보낸다(원시 origin 미노출).
 * 확인·에러 문구는 KnowledgeControls의 기존 trash 키를 재사용해 두 진입점의 표현을 일치시킨다.
 */
export function PageKebabMenu({
  wikiSlug,
  pageSlug,
  currentVersion,
  currentCategory,
  canMove,
  canTrash,
  afterTrash = "refresh",
  triggerClassName,
}: {
  wikiSlug: string;
  pageSlug: string;
  currentVersion: number;
  currentCategory: string | null;
  canMove: boolean;
  canTrash: boolean;
  afterTrash?: "refresh" | "goHome"; // goHome: 지금 보고 있는 페이지를 지웠을 때(상세 헤더·TOC 현재 행)
  triggerClassName?: string;
}) {
  const t = useTranslations("PageMenu");
  const tKc = useTranslations("KnowledgeControls");
  const quick = useQuickNav();
  const router = useRouter();
  const [pending, start] = useTransition();

  const items: KebabMenuItem[] = [];
  if (canMove && quick) {
    items.push({
      key: "move",
      label: t("moveToFolder"),
      onSelect: () => quick.openMove(pageSlug, currentCategory, currentVersion),
    });
  }
  if (canTrash) {
    items.push({
      key: "trash",
      label: t("trash"),
      tone: "danger",
      disabled: pending,
      onSelect: () => {
        if (!window.confirm(tKc("trashConfirm"))) return;
        start(async () => {
          try {
            const result = await trashPageFromMenuAction(wikiSlug, pageSlug, currentVersion);
            if (result.status === "error") {
              window.alert(tKc(`error.${result.code ?? "failed"}`));
              router.refresh(); // versionConflict 등 → 최신 버전으로 재수화 후 재시도 가능
              return;
            }
            if (afterTrash === "goHome") router.push(`/wikis/${encodeURIComponent(wikiSlug)}`);
            else router.refresh();
          } catch {
            // 액션이 throw하는 경로(배포 교체로 액션 ID가 사라졌거나 네트워크 단절).
            // 반환값 검사로는 잡히지 않아 transition의 unhandled rejection이 되고,
            // 파괴적 동작인데도 화면에는 아무 표시가 남지 않는다.
            window.alert(tKc("error.failed"));
          }
        });
      },
    });
  }
  if (items.length === 0) return null;

  return <KebabMenu label={t("open")} items={items} triggerClassName={triggerClassName} busy={pending} />;
}
