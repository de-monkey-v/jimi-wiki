"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { OpenAITransport } from "@/lib/provider";
import { logoutOAuthAction, setOpenAITransportAction } from "./actions";

type Status = { exists: boolean; accountId?: string; expires?: number };
type Avail = { apikey: boolean; oauth: boolean; proxy: boolean };

const TRANSPORT_OPTIONS: { id: OpenAITransport; hint: string }[] = [
  { id: "apikey", hint: "OPENAI_API_KEY" },
  { id: "oauth", hint: "" },
  { id: "proxy", hint: "OPENAI_BASE_URL" },
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
  const t = useTranslations("AdminSettingsOAuthPanel");
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
    setMsg(t("cancelled"));
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
      if (!res.ok) throw new Error(d.error || t("startFailed"));
      setDevice({ userCode: d.userCode, url: d.verificationUrl });
      setMsg(t("openUrlPrompt"));
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
        setMsg(t("loginComplete"));
        router.refresh();
      } else if (result.status === "expired") {
        setMsg(t("codeExpired"));
      } else {
        setMsg(t("error", { message: result.message ?? "" }));
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setMsg(t("error", { message: (e as Error).message }));
        setBusy(false);
      }
    }
  }

  return (
    <section className="border rounded-lg p-4 space-y-3">
      <h2 className="font-semibold">{t("title")}</h2>

      {/* 연결 방식 선택 — 사용 가능한 것만 고를 수 있다. 현재 선택은 강조. */}
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("connectionMethod")}</p>
        <div className="flex flex-wrap gap-2">
          {TRANSPORT_OPTIONS.map((o) => {
            const ok = avail[o.id];
            const current = transport === o.id;
            const hintText = o.id === "oauth" ? t("transport.oauthHint") : o.hint;
            return (
              <form key={o.id} action={setOpenAITransportAction}>
                <input type="hidden" name="transport" value={o.id} />
                <button
                  disabled={!ok || current}
                  title={ok ? "" : t("optionUnavailable", { hint: hintText })}
                  className={`text-sm rounded border px-3 py-1.5 disabled:cursor-not-allowed ${
                    current
                      ? "border-stone-900 bg-stone-900 text-white"
                      : "border-stone-200 hover:bg-gray-50 disabled:opacity-40"
                  }`}
                >
                  {current ? "✓ " : ""}
                  {t(`transport.${o.id}`)}
                  {ok ? "" : ` ${t("unavailable")}`}
                </button>
              </form>
            );
          })}
        </div>
        <p className="text-xs text-gray-500">
          {t.rich("currentDescription", { transport, b: (chunks) => <b>{chunks}</b> })}
        </p>
      </div>

      {status.exists ? (
        <p className="text-sm text-emerald-600">
          {t("loggedIn")}
          {status.accountId ? t("account", { id: status.accountId.slice(0, 8) }) : ""}
          {status.expires ? t("expiresAt", { date: new Date(status.expires).toLocaleString() }) : ""}
        </p>
      ) : (
        <p className="text-sm text-gray-500">{t("notLoggedIn")}</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={startLogin} disabled={busy} className="bg-stone-900 text-white rounded px-4 py-2 text-sm disabled:opacity-50">
          {status.exists ? t("reLogin") : t("loginWithChatGPT")}
        </button>
        {busy && (
          <button type="button" onClick={stop} className="text-sm underline text-gray-600">
            {t("cancel")}
          </button>
        )}
        {status.exists && (
          <form action={logoutOAuthAction}>
            <button className="text-sm text-red-600 underline">{t("logout")}</button>
          </form>
        )}
      </div>

      {device && (
        <div className="text-sm border rounded p-3 bg-gray-50 space-y-1">
          <p>
            {t("step1")}{" "}
            <a href={device.url} target="_blank" rel="noreferrer" className="underline text-blue-600">
              {device.url}
            </a>{" "}
            {t("openLink")}
          </p>
          <p>
            {t("step2")}
            <code className="text-lg font-mono">{device.userCode}</code>
          </p>
        </div>
      )}
      {msg && <p className="text-sm text-gray-600">{msg}</p>}

      <p className="text-xs text-amber-600">{t("warning")}</p>
    </section>
  );
}
