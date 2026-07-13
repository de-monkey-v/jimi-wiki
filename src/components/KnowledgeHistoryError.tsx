"use client";

import { useTranslations } from "next-intl";
import { RouteErrorState } from "@/components/RouteErrorState";

export function KnowledgeHistoryError({ reset }: { reset: () => void }) {
  const t = useTranslations("KnowledgeHistory");
  return <RouteErrorState title={t("errorTitle")} body={t("errorBody")} retry={t("retry")} reset={reset} />;
}
