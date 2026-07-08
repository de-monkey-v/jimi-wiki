"use client";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import type { WikiGraph } from "@/lib/kinds";

function GraphLoading() {
  const t = useTranslations("GraphGraphMount");
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-stone-200 bg-stone-50 text-sm text-stone-400">
      {t("loading")}
    </div>
  );
}

// sigma/graphology는 window/canvas 의존 → 클라이언트 전용. Next 16에선 ssr:false를
// "use client" 모듈 안에서만 쓸 수 있어 이 래퍼를 서버 라우트가 렌더한다.
const GraphCanvas = dynamic(() => import("./GraphCanvas"), {
  ssr: false,
  loading: () => <GraphLoading />,
});

export function GraphMount(props: {
  nodes: WikiGraph["nodes"];
  edges: WikiGraph["edges"];
  slug: string;
  currentSlug?: string;
  height?: number;
  controls?: boolean;
}) {
  return (
    <div style={{ height: props.height ?? 600 }}>
      <GraphCanvas {...props} />
    </div>
  );
}
