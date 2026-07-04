import "server-only";

/**
 * 인메모리 토큰버킷 레이트리밋.
 * ⚠️ 단일 인스턴스 전용 — 상태가 모듈 레벨 Map에 산다. 멀티인스턴스 배포에서는
 * 인스턴스마다 별도 카운터라 전역 한도를 보장하지 못한다. 추후 Redis 등 공유 스토어로 대체.
 * 키: apiKeyId(있으면) 또는 userId. apiWikiGate가 인증 성공 후 호출한다.
 */

// 에이전트 주도 ingest 1회 = create_source + write_page 다수 + search/list/read 반복이라
// 짧은 구간에 수십 호출이 몰린다. 정당 워크플로가 429로 막히지 않도록 여유 있게 잡되,
// 무제한 남용은 시간당 상한으로 막는다. 프로덕션에서 실측 후 조정 가능.
const PER_MINUTE = 120; // 분당 상한(=버킷 용량, 초당 PER_MINUTE/60 리필)
const PER_HOUR = 3000; // 시간당 상한(고정 윈도우)
const HOUR_MS = 3_600_000;
const REFILL_PER_SEC = PER_MINUTE / 60;

type Bucket = { tokens: number; last: number; hourCount: number; hourStart: number };
const buckets = new Map<string, Bucket>();

export type RateResult = { ok: true } | { ok: false; retryAfter: number };

// 메모리 누수 방지: 유휴 버킷을 기회적으로 정리(1시간 넘게 미사용).
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < HOUR_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.last > HOUR_MS && now - b.hourStart > HOUR_MS) buckets.delete(k);
  }
}

/** 요청 1건을 소비 시도. 초과 시 { ok:false, retryAfter(초) }. */
export function checkRateLimit(key: string): RateResult {
  const now = Date.now();
  sweep(now);

  let b = buckets.get(key);
  if (!b) {
    b = { tokens: PER_MINUTE, last: now, hourCount: 0, hourStart: now };
    buckets.set(key, b);
  }

  // 분당 토큰버킷 리필(경과 시간만큼, 용량 상한)
  const elapsedSec = (now - b.last) / 1000;
  b.tokens = Math.min(PER_MINUTE, b.tokens + elapsedSec * REFILL_PER_SEC);
  b.last = now;

  // 시간 고정 윈도우 리셋
  if (now - b.hourStart >= HOUR_MS) {
    b.hourStart = now;
    b.hourCount = 0;
  }

  if (b.hourCount >= PER_HOUR) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.hourStart + HOUR_MS - now) / 1000)) };
  }
  if (b.tokens < 1) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / REFILL_PER_SEC)) };
  }

  b.tokens -= 1;
  b.hourCount += 1;
  return { ok: true };
}
