import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLang } from "./lang";

test("detectLang: 스크립트별 기본 감지", () => {
  assert.equal(detectLang("Hello, what is attention?").code, "en");
  assert.equal(detectLang("셀프 어텐션이 뭐야?").code, "ko");
  assert.equal(detectLang("こんにちは、これは何ですか").code, "ja"); // 히라가나
  assert.equal(detectLang("カタカナのテスト").code, "ja"); // 가타카나
  assert.equal(detectLang("你好，这是什么").code, "zh"); // 한자만(가나·한글 없음)
});

test("detectLang: 빈 문자열은 영어로 폴백", () => {
  assert.equal(detectLang("").code, "en");
});

test("detectLang: 지배 스크립트로 판정 — 영어 본문에 섞인 소수 한글은 영어로", () => {
  // first-match가 아니라 카운트: 라틴 문자가 압도적이면 한글 한 단어가 있어도 영어.
  assert.equal(detectLang("What is 트랜스포머?").code, "en");
  // 반대로 한글이 지배적이면 한국어.
  assert.equal(detectLang("트랜스포머(transformer)는 어텐션 구조다").code, "ko");
});

test("detectLang: 한자+가나면 일본어(중국어보다 가나 우선)", () => {
  assert.equal(detectLang("東京はどこですか").code, "ja");
});

test("detectLang: name은 프롬프트에 넣을 영문 언어명", () => {
  assert.equal(detectLang("안녕").name, "Korean");
  assert.equal(detectLang("hi").name, "English");
  assert.equal(detectLang("你好").name, "Chinese");
});
