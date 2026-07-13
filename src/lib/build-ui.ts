import type { BuildStatus } from "@/generated/prisma/client";

export type KnowledgeBuildStage = "queued" | "extracting" | "staging" | "publishing" | "review" | "done" | "stopped";

/** 별도 mutable stage 없이도 영속화된 artifact coverage로 사용자용 진행 단계를 계산한다. */
export function knowledgeBuildStage(input: {
  status: BuildStatus;
  inputCount: number;
  extractionCount: number;
  draftCount: number;
}): KnowledgeBuildStage {
  if (input.status === "pending") return "queued";
  if (input.status === "running") {
    if (input.extractionCount < input.inputCount) return "extracting";
    if (input.draftCount === 0) return "staging";
    return "publishing";
  }
  if (input.status === "review") return "review";
  if (input.status === "published" || input.status === "publishedDegraded") return "done";
  return "stopped";
}
