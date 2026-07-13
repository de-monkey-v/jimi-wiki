"use client";

import { useTranslations } from "next-intl";
import { RouteErrorState } from "@/components/RouteErrorState";

export default function BuildsError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("KnowledgeBuilds");
  return <RouteErrorState title={t("routeErrorTitle")} body={t("routeErrorBody")} retry={t("retry")} reset={reset} />;
}
