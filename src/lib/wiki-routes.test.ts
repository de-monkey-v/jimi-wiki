import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONTOLOGY_PAGE_SLUG,
  STATIC_WIKI_ROUTE_SLUGS,
  isReservedWikiPageSlug,
  isStaticWikiRouteSlug,
} from "./wiki-routes";

test("모든 정적 위키 라우트는 Page slug를 점유한다", () => {
  for (const slug of STATIC_WIKI_ROUTE_SLUGS) {
    assert.equal(isStaticWikiRouteSlug(slug), true, `${slug}는 정적 라우트`);
    assert.equal(isReservedWikiPageSlug(slug), true, `${slug}는 Page slug로 쓸 수 없음`);
  }
});

test("기존 누락 라우트와 build/history를 예약한다", () => {
  for (const slug of ["ingest", "reading", "docs", "category", "builds", "history"]) {
    assert.equal(isReservedWikiPageSlug(slug), true, `${slug}는 예약되어야 함`);
  }
});

test("휴지통은 기존 Wiki·Page slug와 충돌하지 않는다", () => {
  assert.equal(isStaticWikiRouteSlug("trash"), false);
  assert.equal(isReservedWikiPageSlug("trash"), false);
});

test("온톨로지는 system slug지만 정적 라우트는 아니다", () => {
  assert.equal(isReservedWikiPageSlug(ONTOLOGY_PAGE_SLUG), true);
  assert.equal(isStaticWikiRouteSlug(ONTOLOGY_PAGE_SLUG), false);
});

test("예약 slug 비교는 공백과 대소문자를 정규화한다", () => {
  assert.equal(isReservedWikiPageSlug("  BuIlDs "), true);
  assert.equal(isReservedWikiPageSlug("my-page"), false);
});
