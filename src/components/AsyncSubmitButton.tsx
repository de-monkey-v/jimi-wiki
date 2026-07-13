"use client";

import { useFormStatus } from "react-dom";

/** 서버 액션 진행 상태를 텍스트로 드러내고, 위험 작업은 제출 직전에 한 번 더 확인한다. */
export function AsyncSubmitButton({
  idle,
  pending,
  confirmMessage,
  className,
  disabled = false,
}: {
  idle: string;
  pending: string;
  confirmMessage?: string;
  className?: string;
  disabled?: boolean;
}) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || status.pending}
      aria-disabled={disabled || status.pending}
      aria-live="polite"
      onClick={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
      }}
      className={`${className ?? ""} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {status.pending ? pending : idle}
    </button>
  );
}
