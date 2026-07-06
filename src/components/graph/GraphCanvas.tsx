"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Graph from "graphology";
import Sigma from "sigma";
import type { NodeDisplayData, EdgeDisplayData } from "sigma/types";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { nodeColor, KIND_COLOR, KIND_LABEL, KIND_ORDER, type WikiGraph } from "@/lib/kinds";
import type { PageKind } from "@/generated/prisma/client";

const DIM = "#e7e5e4"; // stone-200 — dim 처리 색

export default function GraphCanvas({
  nodes,
  edges,
  slug,
  currentSlug,
  height = 600,
  controls = false,
}: {
  nodes: WikiGraph["nodes"];
  edges: WikiGraph["edges"];
  slug: string;
  currentSlug?: string;
  height?: number;
  controls?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // 그래프 기본은 "정리된 지식"만 — 소스 노트(원문)는 기본 숨김(체크박스로 재표시).
  // 순수성 이후 note는 아웃링크가 없어 떠다니는 점이 되므로 노이즈 제거.
  const [hiddenKinds, setHiddenKinds] = useState<Set<PageKind>>(new Set<PageKind>(["note"]));
  const [showBroken, setShowBroken] = useState(true);
  const [search, setSearch] = useState("");

  // 리듀서가 최신 컨트롤/호버 상태를 읽도록 ref로 보관(sigma 재생성 없이 refresh만)
  const st = useRef({ hiddenKinds, showBroken, search: "", hovered: null as string | null });

  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  useEffect(() => {
    st.current.hiddenKinds = hiddenKinds;
    st.current.showBroken = showBroken;
    st.current.search = search;
  }, [hiddenKinds, showBroken, search]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const graph = new Graph();
    const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));
    for (const n of nodes) {
      graph.addNode(n.slug, {
        label: n.title,
        x: Math.random(),
        y: Math.random(),
        size: 3 + 8 * Math.sqrt(n.degree / maxDeg) + (n.slug === currentSlug ? 4 : 0),
        color: nodeColor(n),
        kind: n.kind,
        broken: !!n.broken,
        forceLabel: n.slug === currentSlug,
      });
    }
    for (const e of edges) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
        try {
          graph.addEdge(e.source, e.target, { color: DIM, size: 0.6 });
        } catch {
          /* 중복/자기루프 무시 */
        }
      }
    }

    const isHiddenByFilter = (node: string): boolean => {
      const kind = graph.getNodeAttribute(node, "kind") as PageKind | null;
      const broken = graph.getNodeAttribute(node, "broken") as boolean;
      return (!!kind && st.current.hiddenKinds.has(kind)) || (broken && !st.current.showBroken);
    };

    const sigma = new Sigma(graph, el, {
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 8,
      labelColor: { color: "#57534e" },
      labelFont: "ui-sans-serif, system-ui, sans-serif",
      defaultEdgeColor: DIM,
      minCameraRatio: 0.05,
      maxCameraRatio: 8,
    });
    sigmaRef.current = sigma;
    graphRef.current = graph;

    // 노드 리듀서: 필터(숨김) + 검색(비매칭 dim) + 호버(이웃만 강조)
    sigma.setSetting("nodeReducer", (node, data): Partial<NodeDisplayData> => {
      const res: Partial<NodeDisplayData> = { ...data };
      if (isHiddenByFilter(node)) {
        res.hidden = true;
        return res;
      }
      const s = st.current;
      if (s.search) {
        const label = (graph.getNodeAttribute(node, "label") as string) ?? node;
        if (!label.toLowerCase().includes(s.search.toLowerCase())) {
          res.color = DIM;
          res.label = "";
        }
      }
      if (s.hovered && node !== s.hovered && !graph.areNeighbors(s.hovered, node)) {
        res.color = DIM;
        res.label = "";
      }
      return res;
    });

    // 엣지 리듀서: 양끝 필터 숨김 시 숨김 + 호버 시 인접 엣지만
    sigma.setSetting("edgeReducer", (edge, data): Partial<EdgeDisplayData> => {
      const res: Partial<EdgeDisplayData> = { ...data };
      const [s, t] = graph.extremities(edge);
      if (isHiddenByFilter(s) || isHiddenByFilter(t)) {
        res.hidden = true;
        return res;
      }
      const cur = st.current;
      if (cur.hovered && s !== cur.hovered && t !== cur.hovered) res.hidden = true;
      return res;
    });

    // 호버 강조
    sigma.on("enterNode", ({ node }) => {
      st.current.hovered = node;
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("leaveNode", () => {
      st.current.hovered = null;
      sigma.refresh({ skipIndexation: true });
    });
    // 클릭 → 페이지 이동(깨진 노드는 무시)
    sigma.on("clickNode", ({ node }) => {
      if (graph.getNodeAttribute(node, "broken")) return;
      router.push(`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(node)}`);
    });

    // FA2 live 레이아웃 → 안정화 후 정지(Quartz식 군집 애니메이션)
    const settings = forceAtlas2.inferSettings(graph);
    const layout = new FA2Layout(graph, { settings: { ...settings, slowDown: 8 } });
    layout.start();
    let stopped = false;
    const stopTimer = setTimeout(() => {
      layout.stop();
      stopped = true;
    }, 3500);
    // 워커 정지 후 여유를 두고 마우스 히트 인덱스를 최종 위치로 재구축(정지-refresh 레이스 회피)
    const reindexTimer = setTimeout(() => sigma.refresh(), 3800);
    // 안전망: 레이아웃 정지 후 마우스가 그래프에 들어오면 인덱스 확실히 재구축
    const onEnter = () => {
      if (stopped) sigma.refresh();
    };
    el.addEventListener("mouseenter", onEnter);

    // 노드 드래그
    let dragged: string | null = null;
    sigma.on("downNode", ({ node }) => {
      layout.stop();
      stopped = true;
      dragged = node;
      if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
    });
    const mc = sigma.getMouseCaptor();
    const onMove = (e: { x: number; y: number; preventSigmaDefault: () => void; original: Event }) => {
      if (!dragged) return;
      const pos = sigma.viewportToGraph(e);
      graph.setNodeAttribute(dragged, "x", pos.x);
      graph.setNodeAttribute(dragged, "y", pos.y);
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    };
    const onUp = () => {
      if (dragged) {
        sigma.setCustomBBox(null); // 드래그 종료 시 프레임 override 해제(다음 드래그가 현재 범위에서 재고정)
        sigma.refresh(); // 이동한 노드 위치로 히트 인덱스 재구축
      }
      dragged = null;
    };
    mc.on("mousemovebody", onMove);
    mc.on("mouseup", onUp);

    return () => {
      clearTimeout(stopTimer);
      clearTimeout(reindexTimer);
      el.removeEventListener("mouseenter", onEnter);
      mc.removeListener("mousemovebody", onMove);
      mc.removeListener("mouseup", onUp);
      layout.kill();
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [nodes, edges, slug, currentSlug, router]);

  // 컨트롤 변경 시 리렌더(리듀서 재평가)
  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [hiddenKinds, showBroken, search]);

  const onSearch = (q: string) => {
    setSearch(q);
    const g = graphRef.current;
    const s = sigmaRef.current;
    if (!g || !s || !q) return;
    const match = g.nodes().find((n) => ((g.getNodeAttribute(n, "label") as string) ?? n).toLowerCase().includes(q.toLowerCase()));
    if (match) {
      const d = s.getNodeDisplayData(match);
      if (d) s.getCamera().animate({ x: d.x, y: d.y, ratio: 0.5 }, { duration: 500 });
    }
  };

  const toggleKind = (k: PageKind) =>
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const hasBroken = nodes.some((n) => n.broken);

  return (
    <div className="relative overflow-hidden rounded-lg border border-stone-200 bg-white" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      {controls && (
        <div className="absolute left-3 top-3 z-10 w-56 space-y-2 rounded-lg border border-stone-200 bg-white/90 p-3 text-sm shadow-sm backdrop-blur">
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="검색…"
            className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
          />
          <div className="space-y-1">
            {KIND_ORDER.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 text-xs text-stone-600">
                <input type="checkbox" checked={!hiddenKinds.has(k)} onChange={() => toggleKind(k)} />
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[k] }} />
                {KIND_LABEL[k]}
              </label>
            ))}
            {hasBroken && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-600">
                <input type="checkbox" checked={showBroken} onChange={(e) => setShowBroken(e.target.checked)} />
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#dc2626" }} />
                깨진 링크
              </label>
            )}
          </div>
          <div className="border-t border-stone-100 pt-1 text-xs text-stone-400">
            노드 {nodes.length} · 링크 {edges.length}
          </div>
        </div>
      )}
    </div>
  );
}
