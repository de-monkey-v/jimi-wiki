import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseSha, resetReleaseShaCache } from "./release-identity";

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "release-identity-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const SHA = "abeffe4c946a326370bd29a482ba60208e80264e";

test("릴리스 디렉터리의 .jimi-release 커밋 sha 를 그대로 읽는다", () => {
  resetReleaseShaCache();
  withDir((dir) => {
    // deploy.sh 는 `printf '%s\n'` 으로 쓰므로 끝에 개행이 붙는다.
    writeFileSync(join(dir, ".jimi-release"), `${SHA}\n`);
    assert.equal(releaseSha(dir), SHA);
  });
});

// 개발 체크아웃과 빌드 중 staging 에는 이 파일이 없다. 그때 예외를 던지면 readyz 가
// 통째로 500 이 되어, 릴리스 신원을 요구하지 않는 배포까지 롤백된다.
test("파일이 없으면 던지지 않고 null 이다", () => {
  resetReleaseShaCache();
  withDir((dir) => {
    assert.equal(releaseSha(dir), null);
  });
});

test("파일이 비어 있으면 null 이다(빈 문자열을 신원으로 인정하지 않는다)", () => {
  resetReleaseShaCache();
  withDir((dir) => {
    writeFileSync(join(dir, ".jimi-release"), "\n");
    assert.equal(releaseSha(dir), null);
  });
});

// 이 캐시 규칙이 이 모듈의 핵심이다. deploy.sh 는 pnpm build 를 끝낸 뒤에 .jimi-release 를
// 쓰므로, 빌드 중에 읽은 null 을 캐시하면 실행 중에도 영영 null 로 남아 wait_ready 가
// 모든 배포를 실패로 판정한다.
test("null 은 캐시하지 않는다 — 나중에 파일이 생기면 그때 읽힌다", () => {
  resetReleaseShaCache();
  withDir((dir) => {
    assert.equal(releaseSha(dir), null);
    writeFileSync(join(dir, ".jimi-release"), `${SHA}\n`);
    assert.equal(releaseSha(dir), SHA);
  });
});

test("성공한 읽기는 캐시한다 — 릴리스는 프로세스 수명 동안 바뀌지 않는다", () => {
  resetReleaseShaCache();
  withDir((dir) => {
    writeFileSync(join(dir, ".jimi-release"), `${SHA}\n`);
    assert.equal(releaseSha(dir), SHA);
    // 다른 디렉터리를 줘도 캐시된 값이 나온다.
    withDir((other) => {
      writeFileSync(join(other, ".jimi-release"), "0000000000000000000000000000000000000000\n");
      assert.equal(releaseSha(other), SHA);
    });
  });
});
