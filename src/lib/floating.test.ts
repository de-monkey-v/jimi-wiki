import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFloatingPosition } from "./floating";

const viewport = { width: 1000, height: 800 };

test("computeFloatingPosition: 위 공간이 충분하면 top 배치 + 가운데 정렬", () => {
  const pos = computeFloatingPosition(
    { top: 400, left: 450, width: 100, height: 20 },
    { width: 200, height: 40 },
    { placement: "top", offset: 6, viewport },
  );
  assert.equal(pos.placement, "top");
  assert.equal(pos.top, 400 - 6 - 40);
  assert.equal(pos.left, 450 + 50 - 100); // 앵커 중앙 - 폭/2
});

test("computeFloatingPosition: 뷰포트 상단 근처면 bottom으로 플립", () => {
  const pos = computeFloatingPosition(
    { top: 10, left: 450, width: 100, height: 20 },
    { width: 200, height: 40 },
    { placement: "top", offset: 6, viewport },
  );
  assert.equal(pos.placement, "bottom");
  assert.equal(pos.top, 10 + 20 + 6);
});

test("computeFloatingPosition: 뷰포트 하단 근처면 bottom 선호여도 top으로 플립", () => {
  const pos = computeFloatingPosition(
    { top: 770, left: 450, width: 100, height: 20 },
    { width: 200, height: 40 },
    { placement: "bottom", offset: 6, viewport },
  );
  assert.equal(pos.placement, "top");
});

test("computeFloatingPosition: 좌우는 margin 안으로 클램프", () => {
  const nearLeft = computeFloatingPosition(
    { top: 400, left: 0, width: 20, height: 20 },
    { width: 200, height: 40 },
    { viewport },
  );
  assert.equal(nearLeft.left, 8);
  const nearRight = computeFloatingPosition(
    { top: 400, left: 990, width: 20, height: 20 },
    { width: 200, height: 40 },
    { viewport },
  );
  assert.equal(nearRight.left, 1000 - 8 - 200);
});

test("computeFloatingPosition: bottom 선호 + 아래 공간 충분이면 bottom 정상 배치", () => {
  const pos = computeFloatingPosition(
    { top: 100, left: 450, width: 100, height: 20 },
    { width: 200, height: 40 },
    { placement: "bottom", offset: 8, viewport },
  );
  assert.equal(pos.placement, "bottom");
  assert.equal(pos.top, 100 + 20 + 8);
});

test("computeFloatingPosition: 커스텀 margin이 좌우 클램프에 반영", () => {
  const pos = computeFloatingPosition(
    { top: 400, left: 0, width: 20, height: 20 },
    { width: 200, height: 40 },
    { margin: 24, viewport },
  );
  assert.equal(pos.left, 24);
});

test("computeFloatingPosition: 양쪽 다 안 맞고 아래가 더 넓으면 bottom(하단 오버플로우는 최선 배치)", () => {
  const pos = computeFloatingPosition(
    { top: 100, left: 450, width: 100, height: 20 },
    { width: 200, height: 700 },
    { placement: "top", offset: 6, viewport },
  );
  assert.equal(pos.placement, "bottom"); // 위 100 < 아래 680
  assert.equal(pos.top, 100 + 20 + 6); // bottom은 앵커 기준 고정(위쪽 잘림 방지 우선)
});

test("computeFloatingPosition: 양쪽 다 안 맞으면 남는 공간이 큰 쪽", () => {
  const pos = computeFloatingPosition(
    { top: 500, left: 450, width: 100, height: 20 },
    { width: 200, height: 700 },
    { placement: "top", offset: 6, viewport },
  );
  assert.equal(pos.placement, "top"); // 위 500 > 아래 280
  assert.equal(pos.top, 8); // margin으로 클램프
});
