import "server-only";
import { MAX_SOURCE_CHARS } from "@/lib/safe-fetch";
import { stripHtml } from "@/lib/html-text";
import { geminiEnabled, extractTextFromMedia } from "@/lib/gemini";
import { withExternalModelDispatchLock } from "@/lib/model-access";
import type { UsageMeta } from "@/lib/usage";
import type { UploadKind } from "@/lib/file-types";

// 페이지당 이 문자수 미만이면 텍스트 레이어가 없는 스캔본으로 보고 비전 OCR 로 폴백한다.
const SCANNED_CHARS_PER_PAGE = 12;

export interface ExtractResult {
  text: string;
  usedOcr: boolean;
}

export function shouldUseExternalOcr(
  allowExternalAi: boolean,
  providerAvailable: boolean,
  wikiId?: string | null,
): boolean {
  return allowExternalAi && providerAvailable && !!wikiId;
}

function runExternalOcr(buffer: Buffer, mimeType: string, usageMeta?: UsageMeta): Promise<string> {
  if (!usageMeta?.wikiId) {
    throw new Error("external OCR requires a wiki-scoped model policy lock");
  }
  const ocrMeta = { ...usageMeta, wikiId: usageMeta.wikiId, route: "ocr" };
  return withExternalModelDispatchLock(ocrMeta.wikiId, () => extractTextFromMedia(buffer, mimeType, ocrMeta));
}

/**
 * 업로드 파일(zip 제외) → 평문. 파서는 전부 dynamic import 로 격리해 웹 번들을 오염시키지 않는다
 * (article-extractor 패턴과 동일). 결과는 MAX_SOURCE_CHARS 로 잘라 downstream(임베딩/LLM) 폭주를 막는다.
 * 이미지/스캔 PDF 는 Gemini 비전으로 전사하고, LLM 미설정이면 ""(빈 텍스트)로 우아하게 강등한다.
 */
export async function extractText(opts: {
  buffer: Buffer;
  kind: UploadKind;
  mimeType: string;
  usageMeta?: UsageMeta;
  /** false면 어떤 파일 바이트/본문도 외부 OCR provider로 보내지 않는다. */
  allowExternalAi?: boolean;
}): Promise<ExtractResult> {
  const { buffer, kind, mimeType, usageMeta } = opts;
  // 호출부가 명시적으로 허용하고 wiki policy scope를 제공한 경우에만 raw bytes를 dispatch한다.
  const allowExternalAi = opts.allowExternalAi === true;
  let text = "";
  let usedOcr = false;

  switch (kind) {
    case "text":
      text = buffer.toString("utf8");
      break;

    case "docx": {
      const m = await import("mammoth");
      const convertToHtml = (m.default ?? m).convertToHtml;
      const { value } = await convertToHtml({ buffer });
      text = stripHtml(value);
      break;
    }

    case "pptx":
    case "xlsx":
    case "odt":
    case "odp":
    case "ods": {
      const { parseOffice } = await import("officeparser");
      // ocr:false — 문서 안 이미지의 OCR(tesseract)은 끈다(비용·공격면). 텍스트 레이어만 추출.
      const ast = await parseOffice(buffer, { ocr: false, extractAttachments: false });
      text = ((await ast.to("text")).value ?? "").trim();
      break;
    }

    case "pdf": {
      const { getDocumentProxy, extractText: pdfExtractText } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const r = await pdfExtractText(pdf, { mergePages: true });
      text = (typeof r.text === "string" ? r.text : (r.text as string[]).join("\n")).trim();
      const pages = r.totalPages || 1;
      // 텍스트 레이어가 희박하면 스캔본 → 원본 PDF 바이트를 그대로 Gemini 에 투입(페이지 자체 렌더).
      // OCR 은 best-effort 개선일 뿐이므로 실패해도 unpdf 가 뽑은 기존 text 를 그대로 유지한다(부분 텍스트 보존).
      if (text.length < pages * SCANNED_CHARS_PER_PAGE) {
        if (!allowExternalAi) {
          // 희박한 부분 텍스트도 스캔 노이즈일 가능성이 높다. internalOnly 스캔본은 blob-only로 보존한다.
          text = "";
        } else if (shouldUseExternalOcr(allowExternalAi, geminiEnabled(), usageMeta?.wikiId)) {
          try {
            const ocr = await runExternalOcr(buffer, "application/pdf", usageMeta);
            if (ocr.length > text.length) {
              text = ocr;
              usedOcr = true;
            }
          } catch (e) {
            console.error(`[file-extract] 스캔 PDF OCR 실패(부분 텍스트 유지): ${(e as Error).message}`);
          }
        }
      }
      break;
    }

    case "image":
      // OCR 실패는 '텍스트 없음'(빈 문자열)으로 우아하게 강등한다 — 잡을 error 로 떨구지 않고 원본은 보존.
      if (shouldUseExternalOcr(allowExternalAi, geminiEnabled(), usageMeta?.wikiId)) {
        try {
          text = await runExternalOcr(buffer, mimeType, usageMeta);
          usedOcr = text.length > 0;
        } catch (e) {
          console.error(`[file-extract] 이미지 OCR 실패(빈 텍스트로 강등): ${(e as Error).message}`);
          text = "";
        }
      }
      break;

    default:
      text = "";
  }

  return { text: text.slice(0, MAX_SOURCE_CHARS), usedOcr };
}
