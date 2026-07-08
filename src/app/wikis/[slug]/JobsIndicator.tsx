"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { listRunsAction, type RunListItem } from "../actions";

const TYPE_KINDS = new Set(["ingest", "query", "lint"]);
const ACTIVE = new Set(["pending", "running"]);
const RECENT_DONE_MS = 60_000; // 완료 후 이 시간 동안은 pill 유지(결과 확인 기회)

type Translate = (key: string, values?: Record<string, number | string>) => string;

function elapsedLabel(createdAt: string, finishedAt: string | null, now: number, t: Translate): string {
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  const sec = Math.max(0, Math.round((end - new Date(createdAt).getTime()) / 1000));
  return sec < 60 ? t("secondsElapsed", { sec }) : t("minutesElapsed", { min: Math.floor(sec / 60), sec: sec % 60 });
}

function StatusDot({ status }: { status: string }) {
  if (ACTIVE.has(status))
    return <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />;
  if (status === "done") return <span className="shrink-0 text-emerald-600">✓</span>;
  return <span className="shrink-0 text-red-600">✗</span>;
}

/**
 * 전역 잡 인디케이터: 에이전트 잡(ingest 등)이 도는 동안 우하단에 pill로 표시하고,
 * 클릭하면 최근 잡 목록 패널을 보여준다. 잡 완료 시 router.refresh()로 목록·사이드바 갱신.
 */
export function JobsIndicator({ slug }: { slug: string }) {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const router = useRouter();
  const t = useTranslations("WikisSlugJobsIndicator");
  const prevActiveIds = useRef<Set<string>>(new Set());

  const activeCount = runs.filter((r) => ACTIVE.has(r.status)).length;
  const lastFinished = runs.find((r) => r.finishedAt)?.finishedAt;
  const recentlyDone = lastFinished ? now - new Date(lastFinished).getTime() < RECENT_DONE_MS : false;
  const visible = activeCount > 0 || recentlyDone || open;

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

  // 활성 잡이나 열린 패널이 있으면 3초, 아니면 15초 간격으로 폴링(새 잡 시작 감지)
  useEffect(() => {
    const t0 = setTimeout(poll, 0); // 즉시 1회 (effect 내 동기 setState 회피)
    const interval = activeCount > 0 || open ? 3000 : 15000;
    const t = setInterval(poll, interval);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [poll, activeCount, open]);

  if (!visible) return null;

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
                    {ACTIVE.has(r.status) ? t("running") : r.status === "done" ? t("done") : t("failed")} · {elapsedLabel(r.createdAt, r.finishedAt, now, t)}
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
            <span className="text-stone-700">{t("activeCount", { count: activeCount })}</span>
          </>
        ) : (
          <>
            <span className="text-emerald-600">✓</span>
            <span className="text-stone-600">{t("allDone")}</span>
          </>
        )}
      </button>
    </div>
  );
}
