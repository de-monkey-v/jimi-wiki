"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Graph from "graphology";
import Sigma from "sigma";
import type { NodeDisplayData, EdgeDisplayData } from "sigma/types";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import { createNodeBorderProgram } from "@sigma/node-border";
import { nodeColor, KIND_COLOR, KIND_LABEL, KIND_ORDER, type WikiGraph } from "@/lib/kinds";
import type { PageKind } from "@/generated/prisma/client";

const DIM = "#e7e5e4"; // stone-200 — dim 처리 색

// 노드에 흰 헤일로를 둘러 엣지·다른 노드 위에서 또렷하게 떠 보이게(Obsidian/Quartz 느낌).
// 바깥 15% 링 = borderColor(현재 페이지는 강조색, 기본 흰색), 안쪽 = 노드 색.
const NodeHaloProgram = createNodeBorderProgram({
  borders: [
    { size: { value: 0.15 }, color: { attribute: "borderColor", defaultValue: "#ffffff" } },
    { size: { fill: true }, color: { attribute: "color" } },
  ],
});

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
  // 깨진(아직 없는) 노드 호버 시 커서 위치(컨테이너-로컬 px)에 띄우는 툴팁.
  // flipX/flipY: 컨테이너 우/하단 가장자리면 반대쪽으로 뒤집어 overflow-hidden에 잘리지 않게 함.
  // 일부러 init useEffect deps에서 제외 → setTip는 안정적이라 sigma를 재생성하지 않음.
  const [tip, setTip] = useState<{ x: number; y: number; slug: string; flipX: boolean; flipY: boolean } | null>(null);

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
        borderColor: n.slug === currentSlug ? "#44403c" : "#ffffff", // 현재 페이지는 stone-700 링
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
      // 호버 없이도 라벨이 보이게: 임계값 0 → 전 노드가 라벨 대상.
      // density를 올려 대부분 항상 표시하되, 격자 겹침관리로 확대 시 더 드러나 지저분해지지 않게 함.
      labelRenderedSizeThreshold: 0,
      labelDensity: 3,
      labelGridCellSize: 70,
      labelSize: 12,
      labelWeight: "500",
      labelColor: { color: "#44403c" }, // stone-700 — 배경 위 가독성
      labelFont: "ui-sans-serif, system-ui, sans-serif",
      defaultEdgeColor: DIM,
      minCameraRatio: 0.05,
      maxCameraRatio: 8,
      // 흰 헤일로 노드(엣지는 sigma 기본 직선 — 연결 추적이 더 명료)
      defaultNodeType: "halo",
      nodeProgramClasses: { halo: NodeHaloProgram },
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
      if (s.hovered) {
        if (node === s.hovered) {
          res.highlighted = true; // sigma 호버 스타일(라벨 박스 강조)
        } else if (!graph.areNeighbors(s.hovered, node)) {
          res.color = DIM;
          res.label = "";
        }
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
      if (cur.hovered) {
        if (s !== cur.hovered && t !== cur.hovered) {
          res.hidden = true;
        } else {
          // 호버 노드에 붙은 엣지는 그 노드 색으로 물들이고 굵게 강조
          res.color = graph.getNodeAttribute(cur.hovered, "color") as string;
          res.size = 2;
        }
      }
      return res;
    });

    // 호버 강조 + 커서 + 깨진 노드 툴팁
    sigma.on("enterNode", ({ node, event }) => {
      st.current.hovered = node;
      const broken = graph.getNodeAttribute(node, "broken") as boolean;
      // sigma엔 커서 설정이 없어 컨테이너 DOM에 직접 지정: 실 노드=클릭 가능(pointer), 깨진 노드=이동 불가(help)
      el.style.cursor = broken ? "help" : "pointer";
      if (broken) {
        // event.x/event.y는 이미 컨테이너 top-left 기준 px(커서 위치) → 좌표 변환/카메라 보정 불필요.
        // 컨테이너(overflow-hidden) 우/하단 근처면 플립해 잘림 방지(툴팁 폭 200 + 여백, 높이 여유 48).
        setTip({
          x: event.x,
          y: event.y,
          slug: node,
          flipX: event.x > el.clientWidth - 220,
          flipY: event.y > el.clientHeight - 48,
        });
      } else {
        setTip(null);
      }
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("leaveNode", () => {
      st.current.hovered = null;
      el.style.cursor = "";
      setTip(null);
      sigma.refresh({ skipIndexation: true });
    });
    // 클릭 → 페이지 이동(깨진 노드는 무시)
    sigma.on("clickNode", ({ node }) => {
      if (graph.getNodeAttribute(node, "broken")) return;
      router.push(`/wikis/${encodeURIComponent(slug)}/${encodeURIComponent(node)}`);
    });

    // FA2 live 레이아웃 → 안정화 후 정지(Quartz식 군집 애니메이션)
    // adjustSizes: 노드 크기를 고려해 겹침 완화 / linLogMode: 큰 그래프에서 군집을 더 또렷하게 뭉침
    const base = forceAtlas2.inferSettings(graph);
    const settings = { ...base, slowDown: 8, adjustSizes: true, ...(graph.order > 20 ? { linLogMode: true } : {}) };
    const layout = new FA2Layout(graph, { settings });
    layout.start();
    let stopped = false;
    const stopTimer = setTimeout(() => {
      layout.stop();
      // 정지 후 잔여 겹침을 정리해 노드가 서로 파묻히지 않게 함
      noverlap.assign(graph, { maxIterations: 60, settings: { margin: 3, ratio: 1, expansion: 1.1 } });
      stopped = true;
      sigma.refresh();
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
      el.style.cursor = ""; // 호버 커서가 unmount 후에도 남지 않도록 복구
      setTip(null);
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

  // 필터로 노드를 숨기면 마우스가 안 움직여 leaveNode가 안 뜸 → 호버 잔재(툴팁/커서)를 토글 시점에 정리.
  // effect가 아닌 이벤트 핸들러에서 호출(동기 setState-in-effect 회피).
  const clearHoverChrome = () => {
    st.current.hovered = null;
    if (containerRef.current) containerRef.current.style.cursor = "";
    setTip(null);
  };

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

  const toggleKind = (k: PageKind) => {
    clearHoverChrome();
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const hasBroken = nodes.some((n) => n.broken);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-stone-200"
      style={{ height, background: "radial-gradient(circle at 50% 38%, #ffffff 0%, #fafaf9 70%, #f5f5f4 100%)" }}
    >
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
                <input type="checkbox" checked={showBroken} onChange={(e) => { clearHoverChrome(); setShowBroken(e.target.checked); }} />
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
      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[200px] rounded-lg border border-stone-200 bg-white/90 px-2 py-1 text-xs text-stone-600 shadow-sm backdrop-blur"
          style={{
            left: tip.x,
            top: tip.y,
            transform: `translate(${tip.flipX ? "calc(-100% - 12px)" : "12px"}, ${tip.flipY ? "calc(-100% - 12px)" : "12px"})`,
          }}
        >
          <span className="font-medium text-red-600">{tip.slug}</span>
          <span className="text-stone-400"> · </span>
          아직 없는 페이지
        </div>
      )}
    </div>
  );
}
