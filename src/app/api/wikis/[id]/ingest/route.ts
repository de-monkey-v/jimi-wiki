import { NextResponse } from "next/server";
import { apiOrSessionWikiGate, checkGenerativeQuotaResponse, hasBearerAuth, sessionOnlyGate } from "@/lib/api-gate";
import { createIngestRun, createFileIngestRun, parseIngestMode, type IngestInput } from "@/lib/ingest";
import type { ModelAccess } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 서버리스 대비(self-host Node는 무제한)

function parseModelAccess(value: unknown): ModelAccess | null {
  if (value === undefined || value === null || value === "") return "external";
  return value === "external" || value === "internalOnly" ? value : null;
}

/**
 * external 정책 ingest 는 워커에서 생성형 LLM(빌드 큐레이션)을 유발한다 — 경로별로 같은 비용 상한을 건다.
 *  - API 키 경로: apiWikiGate 가 레이트리밋을 이미 소비했으므로 일일 쿼터만 덧붙인다(이중 소비 금지).
 *  - 세션 경로: 기존 sessionOnlyGate(세션 레이트리밋 + 일일 쿼터) 그대로.
 * 어느 쪽이든 AgentRun.userId 로 실행 주체가 기록되어 워커의 사용량 귀속·빌드 전 재쿼터검사가 작동한다.
 */
async function checkGenerativeCost(req: Request, slug: string, userId: string): Promise<NextResponse | null> {
  if (hasBearerAuth(req)) return checkGenerativeQuotaResponse(userId);
  const modelGate = await sessionOnlyGate(slug, { minRole: "editor" });
  return modelGate.ok ? null : modelGate.res;
}

/**
 * POST /api/wikis/:id/ingest — 비동기. 즉시 202 + runId 반환, 처리는 백그라운드(worker).
 * JSON({url|text}) 또는 multipart/form-data(file[])를 받는다. 파일은 각각 개별 잡으로 등록된다.
 * 세션(웹 UI)과 Bearer API 키(외부 에이전트·MCP)를 모두 받는다 — 생성형 비용은 checkGenerativeCost 로 통제.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await apiOrSessionWikiGate(req, id, { minRole: "editor" });
  if (!gate.ok) return gate.res;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    // 파일 업로드는 한 요청이 파일 개수만큼 잡을 만든다 — 요청당 1회인 생성형 비용 검사와 비대칭이다.
    // 세션(사람 UI)에서는 기존대로 허용하되 API 키(자율 에이전트)에는 열지 않는다. MCP도 파일 툴을 노출하지 않는다.
    if (hasBearerAuth(req)) {
      return NextResponse.json({ error: "file_upload_requires_session" }, { status: 403 });
    }
    const form = await req.formData();
    const modelAccess = parseModelAccess(form.get("modelAccess"));
    const mode = parseIngestMode(form.has("mode") ? form.get("mode") : undefined);
    if (!modelAccess) return NextResponse.json({ error: "invalid_model_access" }, { status: 400 });
    if (!mode) return NextResponse.json({ error: "invalid_ingest_mode" }, { status: 400 });
    if (modelAccess === "external" && mode === "curate") {
      const costRes = await checkGenerativeCost(req, id, gate.user.id);
      if (costRes) return costRes;
    }
    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return NextResponse.json({ error: "file_required" }, { status: 400 });
    const runIds: string[] = [];
    try {
      for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const run = await createFileIngestRun(
          gate.wiki.id,
          { buffer, filename: file.name, mimeType: file.type || undefined, modelAccess, mode },
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
  const mode = parseIngestMode(body.mode);
  if (!modelAccess) return NextResponse.json({ error: "invalid_model_access" }, { status: 400 });
  if (!mode) return NextResponse.json({ error: "invalid_ingest_mode" }, { status: 400 });
  if (modelAccess === "external" && mode === "curate") {
    const costRes = await checkGenerativeCost(req, id, gate.user.id);
    if (costRes) return costRes;
  }
  // 필드 화이트리스트: storageKey/filename 등 파일 참조 필드는 클라에서 받지 않는다(워커가 임의 blob 읽는 것 차단).
  // notifyChatId 도 마찬가지 — 봇 경로에서만 서버가 채운다(임의 chat 으로 알림 전송 차단).
  // 파일 업로드는 위 multipart 분기(createFileIngestRun 게이트)로만 허용한다.
  const input: IngestInput = { url: body.url, text: body.text, title: body.title, modelAccess, mode };

  const run = await createIngestRun(gate.wiki.id, input, gate.user.id);

  return NextResponse.json({ runId: run.id, status: "pending" }, { status: 202 });
}
