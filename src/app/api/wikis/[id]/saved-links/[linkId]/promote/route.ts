import { NextResponse } from "next/server";
import {
  apiOrSessionWikiGate,
  checkGenerativeQuotaResponse,
  hasBearerAuth,
  sessionOnlyGate,
} from "@/lib/api-gate";
import { prisma } from "@/lib/db";
import { promoteSavedLink } from "@/lib/saved-link-promotion";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id, linkId } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;
  const link = await prisma.savedLink.findFirst({
    where: { id: linkId, wikiId: gate.wiki.id, userId: gate.user.id },
    select: { promotedRunId: true, promotedAt: true },
  });
  if (!link) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // 기존 run 재조회는 quota를 다시 소비하지 않는다. 새 run 직전에만 비용 경계를 적용한다.
  if (!link.promotedRunId && !link.promotedAt) {
    const cost = hasBearerAuth(req)
      ? await checkGenerativeQuotaResponse(gate.user.id)
      : await sessionOnlyGate(id, { minRole: "editor" }).then((result) => result.ok ? null : result.res);
    if (cost) return cost;
  }
  try {
    const result = await promoteSavedLink(gate.wiki.id, gate.user.id, linkId);
    return NextResponse.json(result, { status: result.status === "pending" ? 202 : 200 });
  } catch (error) {
    const message = (error as Error).message;
    return NextResponse.json(
      { error: message === "saved_link_not_found" ? "not_found" : "promotion_failed" },
      { status: message === "saved_link_not_found" ? 404 : 409 },
    );
  }
}
