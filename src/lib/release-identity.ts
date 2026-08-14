import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 이 프로세스가 실제로 실행 중인 릴리스의 커밋 sha.
 *
 * 배포는 current 심링크를 갈아끼우지만 이미 떠 있는 프로세스의 cwd 는 그때 해석된 릴리스
 * 디렉터리에 그대로 남는다. 그래서 cwd 의 .jimi-release 는 "심링크가 지금 가리키는 릴리스"가
 * 아니라 "이 응답을 만드는 코드의 릴리스"다 — 재시작이 실패해 옛 프로세스가 계속 응답하면
 * 옛 sha 가 나오고, ops/deploy.sh 의 wait_ready 가 그것을 불일치로 잡는다.
 *
 * 성공한 읽기만 캐시한다. ops/deploy.sh 는 `pnpm build` 를 끝낸 **뒤에** staging 디렉터리에
 * .jimi-release 를 쓰고 그 디렉터리를 릴리스 경로로 옮긴다. 즉 빌드 중에는 이 파일이 없고
 * cwd 도 최종 릴리스 경로가 아니므로, 한 번 읽은 null 을 캐시하면 빌드 시점의 값이 그대로
 * 굳는다. 개발 체크아웃에도 이 파일이 없어 null 이다.
 */
let cached: string | null = null;

export function releaseSha(cwd: string = process.cwd()): string | null {
  if (cached !== null) return cached;
  let sha: string;
  try {
    sha = readFileSync(join(cwd, ".jimi-release"), "utf8").trim();
  } catch {
    return null;
  }
  if (sha === "") return null;
  cached = sha;
  return sha;
}

/** 테스트 전용. 프로세스 하나가 여러 cwd 를 흉내 낼 수 있게 캐시를 비운다. */
export function resetReleaseShaCache(): void {
  cached = null;
}
