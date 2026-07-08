import "server-only";
import { assertPublicUrl, MAX_SOURCE_CHARS } from "@/lib/safe-fetch";

// youtube-caption-extractor가 실제로 요청하는 호스트만 허용(InnerTube + timedtext). 라이브러리가
// 고르는 URL을 우리가 강제로 이 집합으로 제한해 SSRF 표면을 닫는다.
const YT_FETCH_HOSTS = new Set([
  "youtubei.googleapis.com",
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
]);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8_000_000;

/** watch?v= / youtu.be / shorts / embed 링크인지(호스트 기준). */
export function isYoutubeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const h = u.hostname.replace(/^www\.|^m\./, "");
  return h === "youtube.com" || h === "youtu.be";
}

/** 11자 영상 ID 추출(유일한 사용자 제어 값). 형식 불일치면 null. */
function extractVideoId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^www\.|^m\./, "");
  let id = "";
  if (h === "youtu.be") {
    id = u.pathname.slice(1).split("/")[0] ?? "";
  } else if (h === "youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? "";
    else if (u.pathname.startsWith("/shorts/")) id = u.pathname.split("/")[2] ?? "";
    else if (u.pathname.startsWith("/embed/")) id = u.pathname.split("/")[2] ?? "";
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// 라이브러리에 주입할 가드된 fetch: 호스트 allowlist + 공인 IP 검증 + 리다이렉트 차단 + 타임아웃 + 크기 상한.
// 라이브러리가 URL을 고르지만, 이 게이트를 통과하지 못하면 요청 자체가 나가지 않는다.
const guardedFetch: typeof fetch = async (input, init) => {
  const urlStr =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("잘못된 URL");
  }
  if (!YT_FETCH_HOSTS.has(u.hostname)) throw new Error(`허용되지 않은 호스트: ${u.hostname}`);
  await assertPublicUrl(u.href); // DNS 재해석 후 사설 IP 재검증(rebind 방어)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u, { ...init, redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) throw new Error("리다이렉트는 허용되지 않습니다");
    const clen = Number(res.headers.get("content-length") ?? "0");
    if (clen && clen > MAX_RESPONSE_BYTES) throw new Error("응답이 너무 큼(>8MB)");
    return res;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 유튜브 영상의 자막을 받아 원문 텍스트로 반환한다. 자막이 곧 영상의 충실한 원본이라는 신뢰모델.
 * 한국어 자막을 우선하되(lang="ko"), 없으면 라이브러리가 첫 트랙으로 폴백한다.
 * 자막 없음/접근 불가/IP 차단 등은 정직하게 throw → 호출부(runIngestJob)가 error 상태로 기록하고,
 * 사용자는 "대본 직접 붙여넣기" 경로로 유도된다(text 입력이 1급 경로).
 */
export async function fetchYoutubeTranscript(url: string): Promise<{ content: string; title?: string }> {
  const videoID = extractVideoId(url);
  if (!videoID) throw new Error("유튜브 영상 ID를 인식할 수 없습니다");

  const { getVideoDetails } = await import("youtube-caption-extractor");
  let details: Awaited<ReturnType<typeof getVideoDetails>>;
  try {
    details = await getVideoDetails({ videoID, lang: "ko", fetch: guardedFetch });
  } catch (e) {
    // 비공개/삭제/연령제한/봇차단(빈 200)/네트워크 등은 여기로 수렴 — 원본을 지어내지 않는다.
    throw new Error(
      `유튜브 자막을 가져오지 못했습니다 — 대본을 직접 붙여넣어 주세요 (${(e as Error).message})`,
    );
  }

  const transcript = (details.subtitles ?? [])
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!transcript) {
    throw new Error("이 영상에서 자막을 찾지 못했습니다 — 대본을 직접 붙여넣어 주세요");
  }

  // 자동 생성 자막이 섞일 수 있음을 정직하게 고지(라이브러리가 manual/ASR을 구조적으로 구분해주지 않음).
  const marker = "> YouTube 자막 (자동 생성 자막이 포함될 수 있어 오탈자 가능)\n\n";
  const content = (marker + transcript).slice(0, MAX_SOURCE_CHARS);
  const title = details.title?.trim() || undefined;
  return { content, title };
}
