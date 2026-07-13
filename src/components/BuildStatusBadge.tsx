import type { BuildStatus } from "@/generated/prisma/client";

const STYLE: Record<BuildStatus, string> = {
  pending: "border-stone-200 bg-stone-50 text-stone-700",
  running: "border-indigo-200 bg-indigo-50 text-indigo-800",
  review: "border-amber-200 bg-amber-50 text-amber-900",
  published: "border-emerald-200 bg-emerald-50 text-emerald-800",
  publishedDegraded: "border-orange-200 bg-orange-50 text-orange-900",
  failed: "border-rose-200 bg-rose-50 text-rose-800",
  cancelled: "border-slate-200 bg-slate-50 text-slate-700",
};

const MARK: Record<BuildStatus, string> = {
  pending: "○",
  running: "◌",
  review: "◇",
  published: "●",
  publishedDegraded: "◐",
  failed: "×",
  cancelled: "—",
};

export function BuildStatusBadge({ status, label }: { status: BuildStatus; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${STYLE[status]}`}>
      <span aria-hidden="true">{MARK[status]}</span>
      {label}
    </span>
  );
}
