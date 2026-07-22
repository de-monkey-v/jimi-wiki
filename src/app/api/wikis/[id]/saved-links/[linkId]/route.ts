import { NextResponse } from "next/server";
import { apiOrSessionWikiGate } from "@/lib/api-gate";
import { trashSavedLink } from "@/lib/saved-links";

export const dynamic = "force-dynamic";

/** DELETE — 읽을거리를 14일 휴지통으로 이동한다. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const { id, linkId } = await params;
  const gate = await apiOrSessionWikiGate(req, id);
  if (!gate.ok) return gate.res;
  try {
    return NextResponse.json(await trashSavedLink(gate.wiki.id, gate.user.id, linkId));
  } catch (error) {
    if (error instanceof Error && error.message === "saved_link_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw error;
  }
}
