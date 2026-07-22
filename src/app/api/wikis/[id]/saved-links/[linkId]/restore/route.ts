import { NextResponse } from "next/server";
import { apiOrSessionWikiGate } from "@/lib/api-gate";
import { restoreSavedLink } from "@/lib/saved-links";

export const dynamic = "force-dynamic";

/** POST — 휴지통의 읽을거리를 복원한다. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const { id, linkId } = await params;
  const gate = await apiOrSessionWikiGate(req, id);
  if (!gate.ok) return gate.res;
  try {
    return NextResponse.json(await restoreSavedLink(gate.wiki.id, gate.user.id, linkId));
  } catch (error) {
    if (error instanceof Error && error.message === "saved_link_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw error;
  }
}
