import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { restoreTrashedWiki } from "@/lib/trash";

export const dynamic = "force-dynamic";

/** POST — 같은 slug·멤버십·API key를 유지한 채 위키 전체를 복원한다. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { confirmSlug?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.confirmSlug !== id) return NextResponse.json({ error: "wiki_confirmation_required" }, { status: 400 });
  const wiki = await prisma.wiki.findFirst({
    where: { slug: id, trashedAt: { not: null }, memberships: { some: { userId: user.id, role: "owner" } } },
    select: { id: true },
  });
  if (!wiki) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const restored = await restoreTrashedWiki(wiki.id);
  return NextResponse.json({ restored: true, slug: restored.slug });
}
