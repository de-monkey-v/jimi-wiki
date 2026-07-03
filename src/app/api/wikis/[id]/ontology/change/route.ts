import { NextResponse } from "next/server";
import { apiWikiGate } from "@/lib/api-gate";
import { renameCategory, mergeCategory, retireCategory } from "@/lib/governance";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/wikis/:id/ontology/change — 카테고리 거버넌스(editor+).
 * body: {op:'rename', from, to} | {op:'merge', from, into} | {op:'retire', slug, reassignTo?}
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;

  let body: { op?: string; from?: string; to?: string; into?: string; slug?: string; reassignTo?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    switch (body?.op) {
      case "rename":
        await renameCategory(gate.wiki.id, String(body.from), String(body.to));
        break;
      case "merge":
        await mergeCategory(gate.wiki.id, String(body.from), String(body.into));
        break;
      case "retire":
        await retireCategory(gate.wiki.id, String(body.slug), body.reassignTo ? String(body.reassignTo) : null);
        break;
      default:
        return NextResponse.json({ error: "unknown_op" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
