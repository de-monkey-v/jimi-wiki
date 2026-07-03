import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { updateMemberRole, removeMember } from "@/lib/members";
import type { Role } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";
const ROLES: Role[] = ["viewer", "editor", "owner"];

/** PATCH /api/wikis/:id/members/:userId — 역할 변경(owner). body: { role } */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!ROLES.includes(body?.role as Role)) return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  try {
    await updateMemberRole(gate.wiki.id, userId, body.role as Role);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** DELETE /api/wikis/:id/members/:userId — 멤버 제거(owner). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  try {
    await removeMember(gate.wiki.id, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
