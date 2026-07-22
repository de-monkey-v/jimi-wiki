import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { geminiEnabled } from "@/lib/gemini";
import { embeddingReadiness } from "@/lib/embedding";
import { authMode } from "@/lib/auth-mode";
import { tailscaleConfigProblems } from "@/lib/tailscale-auth-core";

export const dynamic = "force-dynamic";

const REQUIRED = ["DATABASE_URL", "AUTH_SECRET"];

export async function GET() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  try {
    if (authMode() === "tailscale") missing.push(...tailscaleConfigProblems(process.env));
  } catch {
    missing.push("AUTH_MODE(valid)");
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: false, missing, error: (e as Error).message },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const embedding = await embeddingReadiness();
  const ok = missing.length === 0 && embedding.ready;
  return NextResponse.json(
    { ok, db: true, gemini: geminiEnabled(), embedding, missing },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
