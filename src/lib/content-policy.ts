import type { ModelAccess, PageKind, PageOrigin, RevisionActor } from "@/generated/prisma/client";

/** 외부 모델 허용보다 로컬 전용 정책이 항상 더 엄격하다. */
export function stricterModelAccess(...values: (ModelAccess | null | undefined)[]): ModelAccess {
  return values.some((value) => value === "internalOnly") ? "internalOnly" : "external";
}

/** personal은 요청값과 관계없이 항상 로컬 전용이다. DB CHECK와 같은 규칙의 앱 측 SSOT. */
export function modelAccessForKind(kind: PageKind, requested: ModelAccess): ModelAccess {
  return kind === "personal" ? "internalOnly" : requested;
}

export function isPolicyRelaxation(from: ModelAccess, to: ModelAccess): boolean {
  return from === "internalOnly" && to === "external";
}

/** 과거 콘텐츠를 복사하되 현재보다 약한 AI 정책으로는 절대 되돌리지 않는다. */
export function modelAccessForRestore(
  current: ModelAccess,
  restored: ModelAccess,
  kind: PageKind,
): ModelAccess {
  return modelAccessForKind(kind, stricterModelAccess(current, restored));
}

export function originForCreate(actor: RevisionActor, requested?: PageOrigin): PageOrigin {
  if (actor === "restore") return "mixed";
  if (actor === "agent") return "generated";
  if (actor === "system") return "system";
  void requested;
  return "human";
}

export function isAgentWriteConflict(origin: PageOrigin, actor: RevisionActor, acceptedAiDraft = false): boolean {
  return actor === "agent" && (origin === "human" || origin === "mixed") && !acceptedAiDraft;
}

/**
 * 게시된 Page의 origin 전이. system actor는 정책 전파·archive 같은 유지보수에서도 쓰이므로
 * 기존 origin을 보존하고, system 페이지 생성은 originForCreate 또는 명시 requested로 처리한다.
 */
export function transitionPageOrigin(
  current: PageOrigin,
  actor: RevisionActor,
  options?: { acceptedAiDraft?: boolean; requested?: PageOrigin },
): PageOrigin {
  if (actor === "restore") return "mixed";
  if (actor === "human") return current === "generated" || current === "system" ? "mixed" : current;
  if (actor === "agent") {
    if ((current === "human" || current === "mixed") && options?.acceptedAiDraft) return "mixed";
    return current;
  }
  return current;
}
