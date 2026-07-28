"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DeploymentSkewNotice, useDeploymentSkew } from "@/components/DeploymentSkewNotice";
import { getRunStatusAction } from "../actions";

type RunView = { status: string; error: string | null; summary: string | null; pagesTouched: number };

const KNOWN_STATUSES = ["pending", "running", "done", "error"];

/**
 * ingest 잡 진행 배지: pending/running 동안 2.5초 간격 폴링 → 완료 시 결과 요약을 보여주고
 * router.refresh()로 페이지 목록·사이드바를 갱신한다(수동 새로고침 불필요).
 */
export function RunStatusBadge({
  wikiSlug,
  runId,
  initial,
}: {
  wikiSlug: string;
  runId: string;
  initial: RunView;
}) {
  const t = useTranslations("WikisSlugRunStatusBadge");
  const [run, setRun] = useState<RunView>(initial);
  const router = useRouter();
  const inProgress = run.status === "pending" || run.status === "running";
  const { status: skew, noteSuccess, noteFailure } = useDeploymentSkew();

  // 배포 스큐가 확정되면 폴링을 멈춘다 — 사라진 액션 ID는 재시도로 복구되지 않는다.
  // 단순 연결 끊김은 회복될 수 있으므로 계속 폴링한다.
  useEffect(() => {
    if (!inProgress || skew === "stale") return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const r = await getRunStatusAction(wikiSlug, runId);
        if (cancelled) return;
        noteSuccess();
        if (!r) return;
        setRun(r);
        if (r.status === "done") router.refresh(); // 새 페이지·로그를 즉시 반영
      } catch (e) {
        if (cancelled) return;
        // 일시적 네트워크 오류는 다음 폴링에서 재시도. 배포 교체면 안내를 띄운다.
        noteFailure(e);
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [inProgress, skew, wikiSlug, runId, router, noteSuccess, noteFailure]);

  return (
    <>
      {/* role="status" 안에 role="alert"를 중첩하지 않도록 형제로 둔다. */}
      {skew !== "ok" && <DeploymentSkewNotice status={skew} className="mb-4" />}
      <div
        role="status"
        className={`mb-4 rounded-lg border p-3 text-sm ${
          run.status === "error"
            ? "border-rose-300 bg-rose-50 text-rose-700"
            : run.status === "done"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-indigo-200 bg-indigo-50 text-indigo-700"
        }`}
      >
        <span className="flex items-center gap-2 font-semibold">
          {inProgress && (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent motion-reduce:animate-none" />
          )}
          {t("prefix")} {KNOWN_STATUSES.includes(run.status) ? t(`status.${run.status}`) : run.status}
          {inProgress && <span className="font-normal text-indigo-500">{t("inProgressHint")}</span>}
        </span>
        {run.status === "error" && <p className="mt-1">{run.error}</p>}
        {run.status === "done" && (
          <div className="mt-1 text-emerald-900">
            {run.pagesTouched > 0 && <p className="font-medium">{t("pagesTouched", { count: run.pagesTouched })}</p>}
            {run.summary && <p className="whitespace-pre-wrap text-emerald-800/80">{run.summary.slice(0, 400)}</p>}
          </div>
        )}
      </div>
    </>
  );
}
