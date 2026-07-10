"use client";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/Modal";
import { IngestPanel } from "./IngestPanel";
import { NewPageForm, type CategoryOption } from "./new/NewPageForm";
import { getWikiCategoriesAction } from "../actions";

type NewPagePreset = { category?: string; kind?: string };
type Ctx = { openIngest: () => void; openNewPage: (preset?: NewPagePreset) => void };
const WikiActionsCtx = createContext<Ctx | null>(null);

/** 위키 레이아웃 안 어디서든 ingest·새페이지 모달을 여는 훅. Provider 밖(또는 viewer)에서는 null. */
export function useWikiActions() {
  return useContext(WikiActionsCtx);
}

/**
 * ingest·새페이지를 페이지 이동 없이 모달로 띄우는 provider. 기존 폼(IngestPanel/NewPageForm)을 그대로 재사용.
 * 새페이지의 카테고리 목록은 첫 오픈 때만 서버액션으로 lazy 로드(매 페이지 로드 비용 0).
 */
export function WikiActionsProvider({
  slug,
  wikiKind,
  canWrite,
  children,
}: {
  slug: string;
  wikiKind: "personal" | "project" | "channel";
  canWrite: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("WikisSlugWikiActions");
  const [ingestOpen, setIngestOpen] = useState(false);
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [preset, setPreset] = useState<NewPagePreset>({});
  const [cats, setCats] = useState<CategoryOption[]>([]);
  const loadedCats = useRef(false);

  const openIngest = useCallback(() => setIngestOpen(true), []);
  const openNewPage = useCallback((p?: NewPagePreset) => {
    setPreset(p ?? {});
    setNewPageOpen(true);
    if (!loadedCats.current) {
      loadedCats.current = true;
      getWikiCategoriesAction(slug)
        .then(setCats)
        .catch(() => {
          loadedCats.current = false; // 실패 시 다음 오픈에 재시도
        });
    }
  }, [slug]);

  // viewer 는 트리거가 렌더되지 않으니 context 도 null(open* 미노출).
  const ctx = canWrite ? { openIngest, openNewPage } : null;

  return (
    <WikiActionsCtx.Provider value={ctx}>
      {children}
      {canWrite && (
        <>
          <Modal open={ingestOpen} onClose={() => setIngestOpen(false)} title={t("ingestTitle")}>
            <IngestPanel wikiSlug={slug} />
          </Modal>
          <Modal open={newPageOpen} onClose={() => setNewPageOpen(false)} title={t("newPageTitle")}>
            {/* key로 프리셋 바뀔 때 폼 리마운트 → presetCategory/presetKind가 defaultValue로 반영 */}
            <NewPageForm
              key={`${preset.category ?? ""}:${preset.kind ?? ""}`}
              wikiSlug={slug}
              wikiKind={wikiKind}
              categories={cats}
              presetCategory={preset.category}
              presetKind={preset.kind}
            />
          </Modal>
        </>
      )}
    </WikiActionsCtx.Provider>
  );
}
