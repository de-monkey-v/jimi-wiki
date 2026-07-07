import Image from "next/image";
import type { ReactNode } from "react";

export type EmptyStateAsset =
  | "empty-wikis"
  | "empty-pages"
  | "ingest-flow"
  | "empty-graph"
  | "chat-ready"
  | "read-only-share";

const ASSET_SRC: Record<EmptyStateAsset, string> = {
  "empty-wikis": "/assets/illustrations/empty-wikis.png",
  "empty-pages": "/assets/illustrations/empty-pages.png",
  "ingest-flow": "/assets/illustrations/ingest-flow.png",
  "empty-graph": "/assets/illustrations/empty-graph.png",
  "chat-ready": "/assets/illustrations/chat-ready.png",
  "read-only-share": "/assets/illustrations/read-only-share.png",
};

export function EmptyState({
  asset,
  title,
  body,
  action,
  compact = false,
}: {
  asset: EmptyStateAsset;
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "flex flex-col items-center text-center" : "flex flex-col items-center py-4 text-center"}>
      <Image
        src={ASSET_SRC[asset]}
        alt=""
        aria-hidden="true"
        width={288}
        height={288}
        loading={compact ? "lazy" : "eager"}
        decoding="async"
        className={compact ? "mb-3 h-24 w-24 object-contain" : "mb-4 h-36 w-36 object-contain"}
      />
      <div className={compact ? "text-sm font-semibold text-stone-700" : "font-semibold text-stone-800"}>{title}</div>
      <p className={compact ? "mt-1 max-w-xs text-xs leading-relaxed text-stone-400" : "mt-1 max-w-md text-sm leading-relaxed text-stone-500"}>
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
