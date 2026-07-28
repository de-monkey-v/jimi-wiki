"use client";
import { useCallback, useRef, useState } from "react";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useTranslations } from "next-intl";

// 배포가 교체되면 그 시점에 열려 있던 탭이 들고 있는 Server Action ID가 서버에서 사라진다.
// Next는 이때 404 + x-nextjs-action-not-found 헤더를 내려보내고 클라이언트 라우터가
// UnrecognizedActionError로 reject하므로, 오류 메시지 문자열을 뒤지지 않고 타입으로 확정 판별한다.
//
// 그 외의 실패(일시적 네트워크 단절 등)는 구분할 방법이 없어 "얼마나 오래 계속 실패했는지"로
// 폴백한다. 폴링 간격이 호출부마다 다르므로(2.5초·3초·15초, 백그라운드 탭은 브라우저가
// 60초로 throttle) 실패 '횟수'가 아니라 경과 시간을 기준으로 삼아야 간격에 무관하게 일관된다.
const DISCONNECTED_AFTER_MS = 60_000;

// 두 상태를 구분하는 이유: 배포 교체("stale")는 재시도로 절대 낫지 않으므로 폴링을 끊어야 하지만,
// 오래 끄는 네트워크 장애("disconnected")는 회복될 수 있다. 둘을 뭉뚱그리면 절전에서 깬 노트북이
// 배포한 적도 없는데 "새 버전이 배포됨" 안내를 띄운 채 폴링을 영영 멈춘다.
export type SkewStatus = "ok" | "stale" | "disconnected";

/**
 * 폴링 호출부가 실패를 어떻게 해석할지만 담당한다. 타이머 자체는 각 호출부가 그대로 소유한다
 * — 간격 규칙(동적/조건부)이 서로 달라서 타이머까지 공통화하면 회귀 위험만 커진다.
 */
export function useDeploymentSkew() {
  const [status, setStatus] = useState<SkewStatus>("ok");
  const firstFailureAt = useRef<number | null>(null);

  // 액션이 정상 resolve됐다 = 서버와 클라이언트 배포가 일치한다.
  const noteSuccess = useCallback(() => {
    firstFailureAt.current = null;
    // stale은 확정 상태라 되돌리지 않는다. 같은 값이면 React가 리렌더를 생략한다.
    setStatus((prev) => (prev === "stale" ? prev : "ok"));
  }, []);

  const noteFailure = useCallback((error: unknown) => {
    if (unstable_isUnrecognizedActionError(error)) {
      setStatus("stale"); // 확정 — 재시도해도 절대 복구되지 않는다
      return;
    }
    const now = Date.now();
    if (firstFailureAt.current === null) {
      firstFailureAt.current = now;
      return;
    }
    if (now - firstFailureAt.current >= DISCONNECTED_AFTER_MS) {
      setStatus((prev) => (prev === "stale" ? prev : "disconnected"));
    }
  }, []);

  return { status, noteSuccess, noteFailure };
}

/** 낡거나 끊긴 탭에 새로고침 경로를 보여준다. 기존 rose 톤 role="alert" 패턴을 따른다. */
export function DeploymentSkewNotice({
  status,
  className = "",
}: {
  status: Exclude<SkewStatus, "ok">;
  className?: string;
}) {
  const t = useTranslations("DeploymentSkew");
  return (
    <div
      role="alert"
      aria-live="polite"
      className={`flex items-center gap-3 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm text-rose-700 shadow-xl ${className}`}
    >
      <span className="flex-1">{status === "stale" ? t("message") : t("disconnected")}</span>
      {/* router.refresh()는 RSC 요청이라 낡은 클라이언트 번들이 그대로 남는다.
          새 배포의 번들과 액션 ID로 갈아끼우려면 전체 리로드가 유일하게 확실하다. */}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="btn-danger btn-compact shrink-0"
      >
        {t("reload")}
      </button>
    </div>
  );
}
