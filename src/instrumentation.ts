/**
 * 서버 부팅 시 1회 실행(Next.js instrumentation). 런타임 모델 설정 캐시를 미리 채워
 * 첫 요청이 env 기본이 아니라 관리자가 저장한 DB 값을 쓰게 한다. 비치명적.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { refreshConfig } = await import("@/lib/model-config");
    await refreshConfig().catch(() => {});
  }
}
