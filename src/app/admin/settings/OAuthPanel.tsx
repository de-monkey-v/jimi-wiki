"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OpenAITransport } from "@/lib/provider";
import { logoutOAuthAction, setOpenAITransportAction } from "./actions";

type Status = { exists: boolean; accountId?: string; expires?: number };
type Avail = { apikey: boolean; oauth: boolean; proxy: boolean };

const TRANSPORT_OPTIONS: { id: OpenAITransport; label: string; hint: string }[] = [
  { id: "apikey", label: "API 키", hint: "OPENAI_API_KEY" },
  { id: "oauth", label: "ChatGPT 구독(OAuth)", hint: "로그인 필요" },
  { id: "proxy", label: "프록시", hint: "OPENAI_BASE_URL" },
];
type PollResult = { status: "complete" | "error" | "expired" | "cancelled"; message?: string };

// 폴링 루프는 모듈 레벨(컴포넌트 밖) — Date.now/setTimeout 등 부수효과를 render 순수성 밖에 둔다.
async function pollDevice(
  deviceAuthId: string,
  userCode: string,
  interval: number,
  expiresIn: number,
  signal: AbortSignal,
): Promise<PollResult> {
  const deadline = Date.now() + expiresIn * 1000;
  let delay = interval * 1000;
  while (!signal.aborted && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    if (signal.aborted) return { status: "cancelled" };
    let data: { status: string; message?: string };
    try {
      const res = await fetch("/api/admin/openai/device/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceAuthId, userCode }),
        signal,
      });
      data = await res.json();
    } catch (e) {
      if (signal.aborted || (e as Error).name === "AbortError") return { status: "cancelled" };
      delay = Math.min(delay * 2, 30000); // 일시 오류 → 폴링 주기 증가(endpoint 보호)
      continue;
    }
    if (data.status === "complete") return { status: "complete" };
    if (data.status === "error") return { status: "error", message: data.message };
    delay = interval * 1000; // pending → 정상 주기
  }
  return signal.aborted ? { status: "cancelled" } : { status: "expired" };
}

export function OAuthPanel({ status, transport, avail }: { status: Status; transport: OpenAITransport; avail: Avail }) {
  const router = useRouter();
  const [device, setDevice] = useState<{ userCode: string; url: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // 언마운트/취소 시 폴링 루프를 멈추고 in-flight fetch 를 취소한다.
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => ctrlRef.current?.abort();
  }, []);

  function stop() {
    ctrlRef.current?.abort();
    setBusy(false);
    setDevice(null);
    setMsg("취소됨.");
  }

  async function startLogin() {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBusy(true);
    setMsg("");
    setDevice(null);
    try {
      const res = await fetch("/api/admin/openai/device/start", { method: "POST", signal: ctrl.signal });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "시작 실패");
      setDevice({ userCode: d.userCode, url: d.verificationUrl });
      setMsg("아래 URL 을 열어 코드를 입력하세요. 승인 대기 중…");
      const result = await pollDevice(
        d.deviceAuthId,
        d.userCode,
        Math.max(Number(d.interval) || 5, 3),
        Number(d.expiresIn) || 900,
        ctrl.signal,
      );
      if (result.status === "cancelled") return;
      setBusy(false);
      setDevice(null);
      if (result.status === "complete") {
        setMsg("✓ 로그인 완료");
        router.refresh();
      } else if (result.status === "expired") {
        setMsg("코드가 만료됐습니다 — 다시 시도하세요.");
      } else {
        setMsg("오류: " + result.message);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setMsg("오류: " + (e as Error).message);
        setBusy(false);
      }
    }
  }

  return (
    <section className="border rounded-lg p-4 space-y-3">
      <h2 className="font-semibold">OpenAI 연결 (방식 선택 + ChatGPT 로그인)</h2>

      {/* 연결 방식 선택 — 사용 가능한 것만 고를 수 있다. 현재 선택은 강조. */}
      <div className="space-y-1">
        <p className="text-sm font-medium">연결 방식</p>
        <div className="flex flex-wrap gap-2">
          {TRANSPORT_OPTIONS.map((o) => {
            const ok = avail[o.id];
            const current = transport === o.id;
            return (
              <form key={o.id} action={setOpenAITransportAction}>
                <input type="hidden" name="transport" value={o.id} />
                <button
                  disabled={!ok || current}
                  title={ok ? "" : `${o.hint} 없음`}
                  className={`text-sm rounded border px-3 py-1.5 disabled:cursor-not-allowed ${
                    current
                      ? "border-stone-900 bg-stone-900 text-white"
                      : "border-stone-200 hover:bg-gray-50 disabled:opacity-40"
                  }`}
                >
                  {current ? "✓ " : ""}
                  {o.label}
                  {ok ? "" : " (불가)"}
                </button>
              </form>
            );
          })}
        </div>
        <p className="text-xs text-gray-500">
          현재: <b>{transport}</b> — 이 방식으로 GPT 모델을 호출합니다. 키가 있어도 <b>고른 방식</b>만 씁니다.
        </p>
      </div>

      {status.exists ? (
        <p className="text-sm text-emerald-600">
          로그인됨
          {status.accountId ? ` (계정 ${status.accountId.slice(0, 8)}…)` : ""}
          {status.expires ? ` · 만료 ${new Date(status.expires).toLocaleString()}` : ""}
        </p>
      ) : (
        <p className="text-sm text-gray-500">미로그인 — 개인 ChatGPT 구독으로 GPT 모델을 쓰려면 로그인하세요.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={startLogin} disabled={busy} className="bg-stone-900 text-white rounded px-4 py-2 text-sm disabled:opacity-50">
          {status.exists ? "다시 로그인" : "ChatGPT로 로그인"}
        </button>
        {busy && (
          <button type="button" onClick={stop} className="text-sm underline text-gray-600">
            취소
          </button>
        )}
        {status.exists && (
          <form action={logoutOAuthAction}>
            <button className="text-sm text-red-600 underline">로그아웃</button>
          </form>
        )}
      </div>

      {device && (
        <div className="text-sm border rounded p-3 bg-gray-50 space-y-1">
          <p>
            1){" "}
            <a href={device.url} target="_blank" rel="noreferrer" className="underline text-blue-600">
              {device.url}
            </a>{" "}
            열기
          </p>
          <p>
            2) 코드 입력: <code className="text-lg font-mono">{device.userCode}</code>
          </p>
        </div>
      )}
      {msg && <p className="text-sm text-gray-600">{msg}</p>}

      <p className="text-xs text-amber-600">
        ⚠️ 개인 self-host 전용 — 개인 구독을 나 혼자 쓰는 용도. 여러 사람에게 서비스로 열지 말 것(ChatGPT 약관).
      </p>
    </section>
  );
}
