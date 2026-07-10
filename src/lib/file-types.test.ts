import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUpload } from "./file-types";

const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n", "latin1");
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("classifyUpload: 매직바이트로 컨테이너 판별(확장자 아님)", () => {
  assert.deepEqual(classifyUpload(pdf, "doc.pdf"), { kind: "pdf", ext: "pdf", mimeType: "application/pdf" });
  const png1 = classifyUpload(png, "shot.png");
  assert.equal("kind" in png1 && png1.kind, "image");
  assert.equal("kind" in png1 && png1.ext, "png");
  assert.equal("kind" in classifyUpload(jpeg, "p.jpg") && (classifyUpload(jpeg, "p.jpg") as { kind: string }).kind, "image");
  assert.equal("kind" in classifyUpload(webp, "p.webp") && (classifyUpload(webp, "p.webp") as { kind: string }).kind, "image");
});

test("classifyUpload: ZIP 컨테이너는 확장자로 Office/ODF 세분", () => {
  assert.equal((classifyUpload(zip, "a.docx") as { kind: string }).kind, "docx");
  assert.equal((classifyUpload(zip, "a.pptx") as { kind: string }).kind, "pptx");
  assert.equal((classifyUpload(zip, "a.xlsx") as { kind: string }).kind, "xlsx");
  assert.equal((classifyUpload(zip, "a.odt") as { kind: string }).kind, "odt");
  assert.equal((classifyUpload(zip, "a.zip") as { kind: string }).kind, "zip");
});

test("classifyUpload: 확장자·내용 위장은 거부", () => {
  // PDF 내용인데 .docx 로 위장
  assert.ok("rejected" in classifyUpload(pdf, "malware.docx"));
  // 이미지 내용인데 .txt 로 위장
  assert.ok("rejected" in classifyUpload(png, "note.txt"));
  // ZIP 내용인데 화이트리스트 밖 확장자
  assert.ok("rejected" in classifyUpload(zip, "a.jar"));
});

test("classifyUpload: 평문은 UTF-8 검사 통과 시에만 허용", () => {
  assert.equal((classifyUpload(Buffer.from("# 제목\n본문", "utf8"), "n.md") as { kind: string }).kind, "text");
  assert.equal((classifyUpload(Buffer.from("hello world", "utf8"), "n.txt") as { kind: string }).kind, "text");
  // .txt 로 위장한 바이너리(NUL 포함) 거부
  assert.ok("rejected" in classifyUpload(Buffer.from([0x00, 0x01, 0x02, 0x03]), "fake.txt"));
  // 매직도 없고 화이트리스트 밖 확장자 → 거부
  assert.ok("rejected" in classifyUpload(Buffer.from("data"), "a.exe"));
});
