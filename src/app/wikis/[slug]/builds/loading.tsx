"use client";

import { useTranslations } from "next-intl";
import { RouteLoadingState } from "@/components/RouteLoadingState";

export default function BuildsLoading() {
  const t = useTranslations("KnowledgeBuilds");
  return <RouteLoadingState label={t("loading")} />;
}
