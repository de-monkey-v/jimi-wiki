import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { geminiEnabled } from "@/lib/gemini";
import { embeddingStatus } from "@/lib/embedding";

export const dynamic = "force-dynamic";

const REQUIRED = ["DATABASE_URL", "AUTH_SECRET"];

export async function GET() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (process.env.NODE_ENV === "production") {
    for (const k of ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "INVITE_EMAILS"]) {
      if (!process.env[k]) missing.push(k);
    }
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: false, missing, error: (e as Error).message },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: missing.length === 0, db: true, gemini: geminiEnabled(), embedding: embeddingStatus(), missing },
    { status: missing.length === 0 ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
