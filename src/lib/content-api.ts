import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseBearer } from "@/lib/apikey-core";
import type { ModelAccess, Prisma } from "@/generated/prisma/client";
import { withExternalModelDispatchLock } from "@/lib/model-access";

export function parseModelAccess(value: unknown): ModelAccess | null {
  return value === "external" || value === "internalOnly" ? value : null;
}

export function parseExpectedVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type OptionalExpectedVersion =
  | { state: "absent" }
  | { state: "valid"; value: number }
  | { state: "invalid" };

/** legacy DELETE는 완전 부재만 current-version CAS로 보완한다. 잘못된/상충 입력은 fail-closed다. */
export function optionalExpectedVersionFromRequest(req: Request): OptionalExpectedVersion {
  const params = new URL(req.url).searchParams;
  const queryPresent = params.has("expectedVersion");
  const queryValue = queryPresent ? params.get("expectedVersion") : null;
  const headerValue = req.headers.get("x-jimi-expected-version");
  const headerPresent = headerValue !== null;
  if (!queryPresent && !headerPresent) return { state: "absent" };
  const parse = (raw: string | null): number | null => {
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return parseExpectedVersion(Number(raw));
  };
  const queryVersion = queryPresent ? parse(queryValue) : null;
  const headerVersion = headerPresent ? parse(headerValue) : null;
  if ((queryPresent && queryVersion === null) || (headerPresent && headerVersion === null)) {
    return { state: "invalid" };
  }
  if (queryVersion !== null && headerVersion !== null && queryVersion !== headerVersion) {
    return { state: "invalid" };
  }
  return { state: "valid", value: queryVersion ?? headerVersion! };
}

/**
 * Bearer 콘텐츠 API는 프로그램적 외부-agent 경계다. 모델 trust를 클라이언트가 보낸
 * X-Jimi-Model-Trust 헤더에 맡기지 않는다 — 헤더를 빠뜨린 REST/Hermes 호출도 같은
 * external-only 범위와 agent origin을 적용하고, 헤더만 위조한 세션 요청은 승격하지 않는다.
 */
export function requestsExternalModelScope(req: Request): boolean {
  return parseBearer(req.headers.get("authorization")) !== null;
}

/**
 * MCP/외부 model-tool response는 eligible row 조회부터 JSON 직렬화까지 shared policy lock을
 * 유지한다. downgrade/archive는 이 callback이 끝난 뒤에만 commit할 수 있다.
 */
export function withExternalModelResponseScope<T>(
  req: Request,
  wikiId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return requestsExternalModelScope(req)
    ? withExternalModelDispatchLock(wikiId, fn)
    : fn(prisma);
}

export function purgeConfirmationMatches(req: Request, slug: string): boolean {
  return req.headers.get("x-jimi-confirm-purge") === slug;
}

export function contentMutationErrorResponse(error: unknown): NextResponse {
  const err = error as { code?: string; expectedVersion?: number; actualVersion?: number };
  switch (err?.code) {
    case "CONTENT_NOT_FOUND":
    case "P2025":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "CONTENT_VERSION_CONFLICT":
      return NextResponse.json(
        {
          error: "version_conflict",
          expectedVersion: err.expectedVersion,
          actualVersion: err.actualVersion,
        },
        { status: 409 },
      );
    case "HUMAN_PAGE_CONFLICT":
      return NextResponse.json({ error: "human_page_conflict" }, { status: 409 });
    case "POLICY_RELAXATION_REQUIRES_CONFIRMATION":
      return NextResponse.json(
        { error: "external_access_confirmation_required" },
        { status: 409 },
      );
    case "INVALID_REVISION_PROVENANCE":
      return NextResponse.json({ error: "invalid_revision_provenance" }, { status: 400 });
    case "P2002":
      return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
    default:
      console.error("[content-api] mutation failed", error);
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
