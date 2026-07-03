import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { listMembers, inviteMember } from "@/lib/members";
import type { Role } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["viewer", "editor", "owner"];

/** GET /api/wikis/:id/members — 멤버 목록. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id);
  if (!gate.ok) return gate.res;
  const members = await listMembers(gate.wiki.id);
  return NextResponse.json(
    { members: members.map((m) => ({ userId: m.userId, email: m.user.email, name: m.user.name, role: m.role })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** POST /api/wikis/:id/members — 멤버 초대(owner). body: { email, role } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "owner" });
  if (!gate.ok) return gate.res;
  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.email) return NextResponse.json({ error: "email_required" }, { status: 400 });
  const role = ROLES.includes(body.role as Role) ? (body.role as Role) : "viewer";
  try {
    const res = await inviteMember(gate.wiki.id, body.email, role);
    return NextResponse.json(res, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
