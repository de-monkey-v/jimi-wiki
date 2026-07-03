"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getRunStatusAction } from "../actions";

type RunView = { status: string; error: string | null; summary: string | null; pagesTouched: number };

const RUN_LABEL: Record<string, string> = {
  pending: "대기 중",
  running: "처리 중",
  done: "완료",
  error: "실패",
};

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
  const [run, setRun] = useState<RunView>(initial);
  const router = useRouter();
  const inProgress = run.status === "pending" || run.status === "running";

  useEffect(() => {
    if (!inProgress) return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const r = await getRunStatusAction(wikiSlug, runId);
        if (cancelled || !r) return;
        setRun(r);
        if (r.status === "done") router.refresh(); // 새 페이지·로그를 즉시 반영
      } catch {
        // 일시적 네트워크 오류는 다음 폴링에서 재시도
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [inProgress, wikiSlug, runId, router]);

  return (
    <div
      role="status"
      className={`mb-4 rounded-lg border p-3 text-sm ${
        run.status === "error"
          ? "border-red-300 bg-red-50 text-red-700"
          : run.status === "done"
            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
            : "border-blue-200 bg-blue-50 text-blue-700"
      }`}
    >
      <span className="flex items-center gap-2 font-semibold">
        {inProgress && (
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
        )}
        소스 편입: {RUN_LABEL[run.status] ?? run.status}
        {inProgress && <span className="font-normal text-blue-500">— LLM이 원문을 읽고 페이지로 정리하는 중입니다…</span>}
      </span>
      {run.status === "error" && <p className="mt-1">{run.error}</p>}
      {run.status === "done" && (
        <div className="mt-1 text-emerald-900">
          {run.pagesTouched > 0 && <p className="font-medium">페이지 {run.pagesTouched}개 생성·갱신됨</p>}
          {run.summary && <p className="whitespace-pre-wrap text-emerald-800/80">{run.summary.slice(0, 400)}</p>}
        </div>
      )}
    </div>
  );
}
