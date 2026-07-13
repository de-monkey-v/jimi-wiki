"use client";

import { KnowledgeHistoryError } from "@/components/KnowledgeHistoryError";

export default function PageHistoryError({ reset }: { error: Error; reset: () => void }) {
  return <KnowledgeHistoryError reset={reset} />;
}
