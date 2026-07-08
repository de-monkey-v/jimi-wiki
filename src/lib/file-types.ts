import "server-only";

/**
 * 업로드 파일 분류(신뢰 경계의 유일 게이트).
 *
 * 원칙: 클라이언트가 준 MIME/확장자는 신뢰하지 않는다. 실제 바이트의 매직 시그니처로 컨테이너를
 * 판별하고(=파서 라우팅의 근거), Office/ODF처럼 ZIP 컨테이너를 공유하는 포맷만 확장자로 세분한다.
 * 시그니처와 확장자가 모순되면(위장) 거부한다.
 */

export type UploadKind =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "odt"
  | "odp"
  | "ods"
  | "zip"
  | "image"
  | "text";

/** 파일당 업로드 바이트 상한. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * 한 요청(다중 파일 합계) 바이트 상한. Next Server Action 의 bodySizeLimit 은 요청 '전체' 상한이므로
 * next.config 의 bodySizeLimit 은 이 값 이상으로 두고, 액션은 이 값으로 우아하게 선검증한다(파일당 상한과 별개).
 */
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;

// zip fan-out 방어 상한(zip-bomb/과다 팬아웃 차단). 문자 기준 상한(MAX_SOURCE_CHARS)과 별개의 바이트 기준.
export const ZIP_MAX_ENTRIES = 512;
export const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 해제 총량
export const ZIP_MAX_ENTRY_BYTES = MAX_UPLOAD_BYTES; // 엔트리 하나 = 개별 업로드와 동일 상한
export const ZIP_MAX_RATIO = 100; // 압축비(해제/압축) 상한
export const ZIP_MAX_DEPTH = 1; // 중첩 zip 재귀 깊이

// ZIP 컨테이너 확장자 → kind(모두 PK 시그니처를 공유하므로 확장자로 세분)
const ZIP_EXT_KIND: Record<string, UploadKind> = {
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  odt: "odt",
  odp: "odp",
  ods: "ods",
  zip: "zip",
};

// 평문으로 취급할 확장자(매직 시그니처 없음)
const TEXT_EXTS = new Set(["txt", "md", "markdown", "text", "csv", "tsv", "log", "json", "yaml", "yml", "xml", "html", "htm"]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** kind별 canonical MIME(추출/OCR 라우팅·저장 메타에 사용). */
export const KIND_MIME: Record<UploadKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  zip: "application/zip",
  image: "image/*",
  text: "text/plain",
};

type Container = "pdf" | "zip" | "png" | "jpeg" | "webp" | null;

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

/** 매직 시그니처로 컨테이너 판별. 클라이언트 MIME/확장자는 보지 않는다. */
function sniff(buf: Buffer): Container {
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) return "pdf"; // %PDF-
  // ZIP: 로컬헤더(PK\x03\x04), 빈 아카이브(PK\x05\x06), 스팬(PK\x07\x08)
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return "zip";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"; // \x89PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"; // JPEG SOI
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  )
    return "webp";
  return null;
}

/** 앞부분 바이트가 평문(UTF-8, NUL/과다 제어문자 없음)인지. .txt 위장 바이너리 차단용. */
function looksTextual(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return true; // 빈 파일은 빈 텍스트로 허용
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false; // NUL → 바이너리
    // 탭/개행/캐리지리턴 외의 C0 제어문자 카운트
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / n < 0.1;
}

export type Classification =
  | { kind: UploadKind; ext: string; mimeType: string }
  | { rejected: string };

/**
 * 업로드 파일을 분류한다. 성공 시 {kind, ext(저장키용 canonical 확장자), mimeType}, 실패 시 {rejected: 사유}.
 * 클라이언트가 보낸 MIME 은 신뢰하지 않는다 — 오직 매직 시그니처(+ZIP 세분용 확장자)로만 판별하고,
 * 시그니처↔확장자 모순은 위장으로 간주해 거부한다.
 */
export function classifyUpload(buf: Buffer, filename: string): Classification {
  const ext = extOf(filename);
  const sig = sniff(buf);

  if (sig === "pdf") {
    if (ext && ext !== "pdf") return { rejected: `확장자·내용 불일치(.${ext}인데 PDF)` };
    return { kind: "pdf", ext: "pdf", mimeType: KIND_MIME.pdf };
  }

  if (sig === "png" || sig === "jpeg" || sig === "webp") {
    if (ext && !IMAGE_EXTS.has(ext)) return { rejected: `확장자·내용 불일치(.${ext}인데 이미지)` };
    const canonExt = sig === "jpeg" ? "jpg" : sig; // png/jpg/webp
    return { kind: "image", ext: canonExt, mimeType: `image/${sig === "jpeg" ? "jpeg" : sig}` };
  }

  if (sig === "zip") {
    const kind = ZIP_EXT_KIND[ext];
    if (!kind) return { rejected: `지원하지 않는 압축/문서 형식(.${ext || "확장자없음"})` };
    return { kind, ext, mimeType: KIND_MIME[kind] };
  }

  // 시그니처 없음 → 평문 후보
  if (TEXT_EXTS.has(ext)) {
    if (!looksTextual(buf)) return { rejected: "텍스트 파일이 아님(바이너리 내용)" };
    return { kind: "text", ext: ext || "txt", mimeType: "text/plain" };
  }

  return { rejected: `지원하지 않는 파일 형식(.${ext || "확장자없음"})` };
}
