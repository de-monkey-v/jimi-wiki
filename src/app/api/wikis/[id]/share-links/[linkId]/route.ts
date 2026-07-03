import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { revokeShareLink } from "@/lib/members";

export const dynamic = "force-dynamic";

/** DELETE /api/wikis/:id/share-links/:linkId — 공유 링크 폐기(owner). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const { id, linkId } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  await revokeShareLink(gate.wiki.id, linkId);
  return NextResponse.json({ ok: true });
}
