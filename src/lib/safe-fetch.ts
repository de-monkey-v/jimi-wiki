import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** 원문(Source) 본문 저장 상한. 웹 추출/자막/원시 응답 모두 이 값으로 truncate 후 저장한다. */
export const MAX_SOURCE_CHARS = 200_000;

// SSRF 방어: 사설/루프백/링크로컬(IMDS 169.254.169.254 포함) 주소 차단
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 파싱 실패 → 안전측 차단
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local (클라우드 메타데이터)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
function isPrivateIP(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    return m ? isPrivateIPv4(m[1]) : false;
  }
  return isPrivateIPv4(ip);
}

/** URL을 파싱해 http/https 인지, 그리고 해석된 모든 IP가 공인 주소인지 검증한다. SSRF 방어의 정본. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("잘못된 URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("http/https URL만 허용");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (ips.length === 0) throw new Error("호스트를 확인할 수 없습니다");
  for (const ip of ips) if (isPrivateIP(ip)) throw new Error(`내부/사설 주소로의 요청 차단: ${ip}`);
  return u;
}
