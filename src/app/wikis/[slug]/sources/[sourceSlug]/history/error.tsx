"use client";

import { KnowledgeHistoryError } from "@/components/KnowledgeHistoryError";

export default function SourceHistoryError({ reset }: { error: Error; reset: () => void }) {
  return <KnowledgeHistoryError reset={reset} />;
}
