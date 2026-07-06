import "server-only";
import { hash, verify } from "@node-rs/argon2";

// OWASP 2024 권장 파라미터 (m=19MiB, t=2, p=1). @node-rs/argon2 기본 알고리즘이 argon2id.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** 평문 비밀번호 → argon2id 해시. User.passwordHash에 저장. */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

/** 저장된 해시와 평문 비교. 손상/미지정 해시는 예외를 삼켜 false 반환(로그인 경로가 500 나지 않게). */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
