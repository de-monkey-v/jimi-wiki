import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownExcerpt } from "./preview";

test("markdownExcerpt: 헤딩·강조·리스트 마커를 벗기고 평문만 남긴다", () => {
  const md = "# 제목\n\n**굵게** 그리고 __밑줄굵게__ 텍스트.\n\n- 항목 하나\n1. 번호 항목\n> 인용문";
  assert.equal(markdownExcerpt(md), "제목 굵게 그리고 밑줄굵게 텍스트. 항목 하나 번호 항목 인용문");
});

test("markdownExcerpt: 위키링크는 라벨(없으면 타깃)로 치환", () => {
  assert.equal(markdownExcerpt("[[transformer|트랜스포머]] 구조와 [[attention]] 참고"), "트랜스포머 구조와 attention 참고");
});

test("markdownExcerpt: 링크는 텍스트만, 이미지는 제거", () => {
  assert.equal(markdownExcerpt("[문서](https://example.com) 그리고 ![alt](img.png) 끝"), "문서 그리고 끝");
});

test("markdownExcerpt: 코드펜스는 통째로 제거, 인라인 코드는 내용 유지", () => {
  assert.equal(markdownExcerpt("전 `npm test` 후\n```js\nconst x = 1;\n```\n다음"), "전 npm test 후 다음");
});

test("markdownExcerpt: 미종결 코드펜스도 제거(발췌가 코드로 도배되지 않게)", () => {
  assert.equal(markdownExcerpt("서두\n```\nraw code line"), "서두");
});

test("markdownExcerpt: 괄호 앞 강조와 단일 문자 강조도 벗긴다", () => {
  assert.equal(markdownExcerpt("중요(*a*) 그리고 *b* 끝"), "중요(a) 그리고 b 끝");
});

test("markdownExcerpt: 잔여 HTML 태그 제거", () => {
  assert.equal(markdownExcerpt('앞 <span class="x">중간</span> 뒤'), "앞 중간 뒤");
});

test("markdownExcerpt: max 초과 시 말줄임", () => {
  const out = markdownExcerpt("가나다라 ".repeat(200), 50);
  assert.ok(out.length <= 51);
  assert.ok(out.endsWith("…"));
});
