"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { listRunsAction, type RunListItem } from "../actions";

const TYPE_KINDS = new Set(["ingest", "query", "lint"]);
const ACTIVE = new Set(["pending", "running"]);
const KNOWN_STAGES = new Set(["fetch", "curate", "embed", "lint"]);
const RECENT_DONE_MS = 60_000; // 완료 후 이 시간 동안 pill에 "방금 완료" 강조(그 뒤엔 유휴 표시로 복귀)

type Translate = (key: string, values?: Record<string, number | string>) => string;

// running은 startedAt(실제 실행 시작) 기준, 그 외는 createdAt(큐 진입) 기준으로 경과를 잰다.
function elapsedLabel(r: RunListItem, now: number, t: Translate): string {
  const base = r.status === "running" && r.startedAt ? r.startedAt : r.createdAt;
  const end = r.finishedAt ? new Date(r.finishedAt).getTime() : now;
  const sec = Math.max(0, Math.round((end - new Date(base).getTime()) / 1000));
  return sec < 60 ? t("secondsElapsed", { sec }) : t("minutesElapsed", { min: Math.floor(sec / 60), sec: sec % 60 });
}

// 상태·단계를 사람이 읽는 라벨로. running이면 현재 단계(수집/큐레이션/임베딩/점검)를 보여 "잘 돌고 있는지" 드러낸다.
function stateText(r: RunListItem, t: Translate): string {
  if (r.status === "pending") return t("waiting");
  if (r.status === "running") return r.stage && KNOWN_STAGES.has(r.stage) ? t(`stage.${r.stage}`) : t("running");
  return r.status === "done" ? t("done") : t("failed");
}

function StatusDot({ status }: { status: string }) {
  if (ACTIVE.has(status))
    return <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />;
  if (status === "done") return <span className="shrink-0 text-emerald-600">✓</span>;
  return <span className="shrink-0 text-red-600">✗</span>;
}

/**
 * 전역 잡 인디케이터(우하단 상시 노출): 유휴에도 작은 pill로 남아 "돌아와서 확인할 자리"가 된다.
 * 잡이 도는 동안 현재 단계를 실시간 표시하고, 클릭하면 최근 잡 목록 패널을 연다.
 * 잡 완료 시 router.refresh()로 목록·사이드바 갱신.
 */
export function JobsIndicator({ slug }: { slug: string }) {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const router = useRouter();
  const t = useTranslations("WikisSlugJobsIndicator");
  const prevActiveIds = useRef<Set<string>>(new Set());

  const activeRuns = runs.filter((r) => ACTIVE.has(r.status));
  const activeCount = activeRuns.length;
  const newestActive = activeRuns[0]; // listRunsAction은 createdAt desc — 첫 활성이 최신
  const lastFinished = runs.find((r) => r.finishedAt)?.finishedAt;
  const recentlyDone = lastFinished ? now - new Date(lastFinished).getTime() < RECENT_DONE_MS : false;

  const poll = useCallback(async () => {
    try {
      const list = await listRunsAction(slug);
      if (!list) return;
      setNow(Date.now());
      // 실행 중이던 잡이 완료로 전이하면 서버 컴포넌트 갱신(페이지 목록·TOC 반영)
      const nowActive = new Set(list.filter((r) => ACTIVE.has(r.status)).map((r) => r.id));
      const completed = [...prevActiveIds.current].some((id) => !nowActive.has(id));
      prevActiveIds.current = nowActive;
      setRuns(list);
      if (completed) router.refresh();
    } catch {
      // 일시적 오류는 다음 폴링에서 재시도
    }
  }, [slug, router]);

  // 활성 잡이나 열린 패널이 있으면 3초, 아니면 15초 간격으로 폴링(새 잡 시작·단계 전이 감지)
  useEffect(() => {
    const t0 = setTimeout(poll, 0); // 즉시 1회 (effect 내 동기 setState 회피)
    const interval = activeCount > 0 || open ? 3000 : 15000;
    const iv = setInterval(poll, interval);
    return () => {
      clearTimeout(t0);
      clearInterval(iv);
    };
  }, [poll, activeCount, open]);

  return (
    <div className="fixed bottom-8 right-24 z-30 flex flex-col items-end gap-2">
      {open && (
        <div className="w-96 max-w-[min(24rem,calc(100%-2rem))] rounded-xl border border-stone-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-stone-700">{t("title")}</h2>
            <button onClick={() => setOpen(false)} aria-label={t("close")} className="text-stone-400 hover:text-stone-700">✕</button>
          </div>
          <ul className="max-h-80 overflow-y-auto p-2">
            {runs.length === 0 && <li className="px-2 py-3 text-sm text-stone-400">{t("empty")}</li>}
            {runs.map((r) => (
              <li key={r.id} className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-stone-50">
                <span className="mt-0.5"><StatusDot status={r.status} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="rounded bg-stone-100 px-1.5 text-[10px] text-stone-500">{TYPE_KINDS.has(r.type) ? t(`type.${r.type}`) : r.type}</span>
                    <span className="truncate text-sm text-stone-700">{r.title}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-stone-400">
                    {stateText(r, t)} · {elapsedLabel(r, now, t)}
                    {r.status === "done" && r.pagesTouched > 0 && <> · {t("pagesTouched", { count: r.pagesTouched })}</>}
                    {r.costUSD !== null && (
                      <>
                        {" "}· ${r.costUSD.toFixed(3)}
                        {r.totalTokens !== null && <> ({Math.round(r.totalTokens / 1000)}K tok)</>}
                      </>
                    )}
                  </div>
                  {r.error && <p className="mt-0.5 truncate text-xs text-red-600">{r.error}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm shadow-lg hover:border-blue-400"
      >
        {activeCount > 0 ? (
          <>
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span className="text-stone-700">
              {t("activeCount", { count: activeCount })}
              {newestActive && <span className="text-stone-400"> · {stateText(newestActive, t)}</span>}
            </span>
          </>
        ) : recentlyDone ? (
          <>
            <span className="text-emerald-600">✓</span>
            <span className="text-stone-600">{t("allDone")}</span>
          </>
        ) : (
          <>
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-stone-300" />
            <span className="text-stone-500">{t("noJobs")}</span>
          </>
        )}
      </button>
    </div>
  );
}
