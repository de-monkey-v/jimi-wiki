export type KnowledgeOrigin = "human" | "generated" | "mixed" | "system";
export type KnowledgeModelAccess = "external" | "internalOnly";

export interface KnowledgeBadgeLabels {
  origin: Record<KnowledgeOrigin, string>;
  modelAccess: Record<KnowledgeModelAccess, string>;
  /** 두 badge를 묶는 접근성 라벨. 생략하면 각 badge 텍스트만 읽힌다. */
  group?: string;
}

const ORIGIN_STYLE: Record<KnowledgeOrigin, { icon: string; className: string }> = {
  human: { icon: "✎", className: "border-stone-200 bg-stone-50 text-stone-700" },
  generated: { icon: "✦", className: "border-indigo-200 bg-indigo-50 text-indigo-700" },
  mixed: { icon: "◐", className: "border-amber-200 bg-amber-50 text-amber-800" },
  system: { icon: "◆", className: "border-slate-200 bg-slate-50 text-slate-600" },
};

const ACCESS_STYLE: Record<KnowledgeModelAccess, { className: string }> = {
  external: { className: "border-indigo-200 bg-white text-indigo-700" },
  internalOnly: { className: "border-amber-200 bg-white text-amber-800" },
};

const BADGE_BASE =
  "inline-flex min-h-6 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-none";

function AccessShieldIcon({ internal }: { internal: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none">
      <path
        d="M8 1.5 13 3v3.8c0 3.3-1.9 5.9-5 7.7-3.1-1.8-5-4.4-5-7.7V3l5-1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {internal ? (
        <path d="M6.2 7.5h3.6v2.8H6.2V7.5Zm.8 0V6.4a1 1 0 0 1 2 0v1.1" stroke="currentColor" strokeWidth="1" />
      ) : (
        <path d="m6.2 9.6 3.6-3.5m-2.4 0h2.4v2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * Page/Source 상태를 색만이 아닌 icon+텍스트로 표시한다.
 * 문구는 호출부가 next-intl로 번역해 넘겨 이 컴포넌트는 locale에 독립적이다.
 */
export function KnowledgeBadges({
  origin,
  modelAccess,
  labels,
  className = "",
}: {
  origin?: KnowledgeOrigin;
  modelAccess: KnowledgeModelAccess;
  labels: KnowledgeBadgeLabels;
  className?: string;
}) {
  const originMeta = origin ? ORIGIN_STYLE[origin] : null;
  const accessMeta = ACCESS_STYLE[modelAccess];

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}
      {...(labels.group ? { role: "group", "aria-label": labels.group } : {})}
    >
      {origin && originMeta && (
        <span className={`${BADGE_BASE} ${originMeta.className}`}>
          <span aria-hidden="true" className="text-[0.7rem]">
            {originMeta.icon}
          </span>
          {labels.origin[origin]}
        </span>
      )}
      <span className={`${BADGE_BASE} ${accessMeta.className}`}>
        <AccessShieldIcon internal={modelAccess === "internalOnly"} />
        {labels.modelAccess[modelAccess]}
      </span>
    </span>
  );
}
