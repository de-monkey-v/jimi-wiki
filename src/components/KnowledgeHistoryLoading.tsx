"use client";

import { useTranslations } from "next-intl";
import { RouteLoadingState } from "@/components/RouteLoadingState";

export function KnowledgeHistoryLoading() {
  const t = useTranslations("KnowledgeHistory");
  return <RouteLoadingState label={t("loading")} />;
}
