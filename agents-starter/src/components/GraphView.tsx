import { useRef, useEffect, useState } from "react";
import * as d3 from "d3";
import type { GraphNode, GraphEdge } from "../types";
import { TAG_COLORS } from "../graph";

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  tags: string[];
  size: number;
  color: string;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  type: "dependency" | "shared_conversation";
  weight?: number;
}

interface TooltipData {
  x: number;
  y: number;
  node: SimNode;
}

interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (id: string) => void;
  filteredNodeIds?: Set<string> | null;
}

export default function GraphView({
  nodes,
  edges,
  onNodeClick,
  filteredNodeIds
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Track dimensions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setDimensions({ width, height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // D3 force simulation
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || nodes.length === 0) return;

    const { width, height } = dimensions;

    // Clear previous
    d3.select(svg).selectAll("*").remove();

    // Create sim data (D3 mutates these)
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }));
    const simLinks: SimLink[] = edges
      .map((e) => {
        const source = simNodes.find((n) => n.id === e.source);
        const target = simNodes.find((n) => n.id === e.target);
        if (!source || !target) return null;
        return { source, target, type: e.type, weight: e.weight };
      })
      .filter(Boolean) as SimLink[];

    // SVG setup
    const svgEl = d3.select(svg);
    const g = svgEl.append("g");

    // Zoom
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });
    svgEl.call(zoom);

    // Edges
    const link = g
      .append("g")
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("stroke", "#404040")
      .attr("stroke-width", (d) => (d.weight ? Math.min(d.weight + 1, 4) : 1.5))
      .attr("stroke-dasharray", (d) =>
        d.type === "shared_conversation" ? "4,4" : "none"
      );

    // Node groups
    const node = g
      .append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(simNodes)
      .join("g")
      .attr("cursor", "pointer");

    // Circles
    node
      .append("circle")
      .attr("r", (d) => d.size)
      .attr("fill", (d) => d.color)
      .attr("stroke", "#1a1a1a")
      .attr("stroke-width", 1.5);

    // Labels
    node
      .append("text")
      .text((d) => d.id)
      .attr("dy", (d) => d.size + 14)
      .attr("text-anchor", "middle")
      .attr("fill", "#e5e5e5")
      .attr("font-size", "11px")
      .attr("pointer-events", "none");

    // Hover
    node
      .on("mouseenter", function (event: MouseEvent, d: SimNode) {
        d3.select(this).select("circle").attr("stroke", "#f97316").attr("stroke-width", 2.5);
        const rect = (event.target as Element).getBoundingClientRect();
        setTooltip({ x: rect.left + rect.width / 2, y: rect.top - 8, node: d });
      })
      .on("mouseleave", function () {
        d3.select(this).select("circle").attr("stroke", "#1a1a1a").attr("stroke-width", 1.5);
        setTooltip(null);
      });

    // Click
    node.on("click", (_event: MouseEvent, d: SimNode) => {
      onNodeClick(d.id);
    });

    // Drag
    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    node.call(drag);

    // Simulation
    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(120)
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<SimNode>().radius((d) => d.size + 8))
      .on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x!)
          .attr("y1", (d) => (d.source as SimNode).y!)
          .attr("x2", (d) => (d.target as SimNode).x!)
          .attr("y2", (d) => (d.target as SimNode).y!);

        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    return () => {
      simulation.stop();
    };
  }, [nodes, edges, dimensions, onNodeClick]);

  // Apply filter dimming
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const svgEl = d3.select(svg);

    if (!filteredNodeIds) {
      // No filter — full opacity
      svgEl.selectAll<SVGGElement, SimNode>("g g g").attr("opacity", 1);
      svgEl.selectAll("line").attr("opacity", 0.6);
      return;
    }

    // Dim non-matching nodes
    svgEl.selectAll<SVGGElement, SimNode>("g g g").attr("opacity", (d) =>
      d && d.id && filteredNodeIds.has(d.id) ? 1 : 0.15
    );

    // Dim edges connected to dimmed nodes
    svgEl.selectAll<SVGLineElement, SimLink>("line").attr("opacity", (d) => {
      const src = (d.source as SimNode).id;
      const tgt = (d.target as SimNode).id;
      return filteredNodeIds.has(src) && filteredNodeIds.has(tgt) ? 0.6 : 0.08;
    });
  }, [filteredNodeIds]);

  // Empty state
  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-kumo-subtle p-8">
        <div className="text-center">
          <p className="text-sm">No skills yet.</p>
          <p className="text-xs mt-1">
            Ingest conversations to build your skill graph.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden">
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="w-full h-full"
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 bg-kumo-base border border-kumo-line rounded-lg shadow-lg pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)"
          }}
        >
          <p className="text-sm font-medium text-kumo-default">
            {tooltip.node.id}
          </p>
          <div className="flex gap-1 mt-1">
            {tooltip.node.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{
                  backgroundColor:
                    (TAG_COLORS[tag.toLowerCase()] || TAG_COLORS.default) + "30",
                  color: TAG_COLORS[tag.toLowerCase()] || TAG_COLORS.default
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-2 left-2 flex flex-wrap gap-2 text-[10px] text-kumo-subtle">
        <span>
          <span className="inline-block w-3 h-0.5 bg-[#404040] mr-1 align-middle" />
          dependency
        </span>
        <span>
          <span
            className="inline-block w-3 h-0.5 mr-1 align-middle"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, #404040 0 3px, transparent 3px 6px)"
            }}
          />
          shared conv.
        </span>
      </div>
    </div>
  );
}
