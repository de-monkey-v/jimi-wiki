"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

/** 세션 전용 revision API를 호출해 정책 전파까지 포함한 복원을 수행한다. */
export function RevisionRestoreControl({
  apiUrl,
  revisionId,
  expectedVersion,
  idle,
  pendingLabel,
  confirmMessage,
  failedLabel,
}: {
  apiUrl: string;
  revisionId: string;
  expectedVersion: number;
  idle: string;
  pendingLabel: string;
  confirmMessage: string;
  failedLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          if (!window.confirm(confirmMessage)) return;
          setPending(true);
          setError(null);
          try {
            const response = await fetch(apiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ revisionId, expectedVersion }),
            });
            if (!response.ok) {
              const body = await response.json().catch(() => null) as { error?: unknown } | null;
              const code = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
              throw new Error(code);
            }
            router.replace(pathname);
            router.refresh();
          } catch (cause) {
            setError(`${failedLabel} (${cause instanceof Error ? cause.message : String(cause)})`);
          } finally {
            setPending(false);
          }
        }}
        aria-live="polite"
        className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? pendingLabel : idle}
      </button>
      {error ? <p role="alert" className="mt-2 text-xs font-medium text-rose-700">{error}</p> : null}
    </div>
  );
}
