import { normalizeSlug } from "@/lib/markdown";
import type { PageKind, PageOrigin } from "@/generated/prisma/client";

export const PAGE_SOURCE_PROMOTION_REASON_PREFIX = "promoted from PageRevision:";

export function pageSourcePromotionReason(pageRevisionId: string): string {
  return `${PAGE_SOURCE_PROMOTION_REASON_PREFIX}${pageRevisionId}`;
}

/** 같은 Page revision의 중복 편입은 같은 root를 사용하고, 실제 충돌만 숫자 suffix로 피한다. */
export function pageSourcePromotionRootSlug(pageSlug: string, version: number, pageRevisionId: string): string {
  const normalized = normalizeSlug(pageSlug).replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "page";
  const revisionToken = normalizeSlug(pageRevisionId).slice(-10) || "revision";
  return `page-${normalized}-v${version}-${revisionToken}`;
}

export function isPageSourcePromotionEligible(input: {
  origin: PageOrigin;
  kind: PageKind;
  archivedAt: Date | null;
  reserved: boolean;
}): boolean {
  return (
    input.archivedAt == null &&
    !input.reserved &&
    (input.origin === "human" || input.origin === "mixed") &&
    (input.kind === "concept" || input.kind === "entity" || input.kind === "meta")
  );
}
