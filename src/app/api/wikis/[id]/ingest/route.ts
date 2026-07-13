import { NextResponse } from "next/server";
import { sessionOnlyGate, sessionWikiGate } from "@/lib/api-gate";
import { createIngestRun, createFileIngestRun, type IngestInput } from "@/lib/ingest";
import type { ModelAccess } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 서버리스 대비(self-host Node는 무제한)

function parseModelAccess(value: unknown): ModelAccess | null {
  if (value === undefined || value === null || value === "") return "external";
  return value === "external" || value === "internalOnly" ? value : null;
}

/**
 * POST /api/wikis/:id/ingest — 비동기. 즉시 202 + runId 반환, 처리는 백그라운드(worker).
 * JSON({url|text}) 또는 multipart/form-data(file[])를 받는다. 파일은 각각 개별 잡으로 등록된다.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await sessionWikiGate(id, { minRole: "editor" }); // 세션 전용. external만 아래에서 생성형 quota를 소비한다.
  if (!gate.ok) return gate.res;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const modelAccess = parseModelAccess(form.get("modelAccess"));
    if (!modelAccess) return NextResponse.json({ error: "invalid_model_access" }, { status: 400 });
    if (modelAccess === "external") {
      const modelGate = await sessionOnlyGate(id, { minRole: "editor" });
      if (!modelGate.ok) return modelGate.res;
    }
    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return NextResponse.json({ error: "file_required" }, { status: 400 });
    const runIds: string[] = [];
    try {
      for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const run = await createFileIngestRun(
          gate.wiki.id,
          { buffer, filename: file.name, mimeType: file.type || undefined, modelAccess },
          gate.user.id,
        );
        runIds.push(run.id);
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    return NextResponse.json({ runIds, status: "pending" }, { status: 202 });
  }

  let body: IngestInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || (!body.url && !body.text)) {
    return NextResponse.json({ error: "url_or_text_required" }, { status: 400 });
  }
  const modelAccess = parseModelAccess(body.modelAccess);
  if (!modelAccess) return NextResponse.json({ error: "invalid_model_access" }, { status: 400 });
  if (modelAccess === "external") {
    const modelGate = await sessionOnlyGate(id, { minRole: "editor" });
    if (!modelGate.ok) return modelGate.res;
  }
  // 필드 화이트리스트: storageKey/filename 등 파일 참조 필드는 클라에서 받지 않는다(워커가 임의 blob 읽는 것 차단).
  // 파일 업로드는 위 multipart 분기(createFileIngestRun 게이트)로만 허용한다.
  const input: IngestInput = { url: body.url, text: body.text, title: body.title, modelAccess };

  const run = await createIngestRun(gate.wiki.id, input, gate.user.id);

  return NextResponse.json({ runId: run.id, status: "pending" }, { status: 202 });
}
