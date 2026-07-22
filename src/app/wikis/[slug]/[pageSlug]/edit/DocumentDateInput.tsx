"use client";

import { useState } from "react";

function localDateTimeValue(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** 브라우저 현지 시각으로 편집하고 서버에는 명시적 UTC ISO를 전송한다. */
export function DocumentDateInput({ value }: { value: string }) {
  const [localValue, setLocalValue] = useState(() => localDateTimeValue(value));
  return (
    <>
      <input type="hidden" name="documentAt" value={localValue ? new Date(localValue).toISOString() : ""} />
      <input
        type="datetime-local"
        suppressHydrationWarning
        value={localValue}
        onChange={(event) => setLocalValue(event.target.value)}
        className="w-full rounded border bg-white px-3 py-2"
      />
    </>
  );
}
