# Task 4 — Day 4: Graph Visualization (Claude Code Execution Plan)

> Hand this file to Claude Code. Prereq: Day 1-3 complete (Agent with skills in SQLite, state sync working, ingestion + refinement + CRUD operational).
> Reference: prompt-skill-forge-v2.md (Section 5 — Graph Visualization Spec), sprint-plan.md (Day 4), test/day4-graph.test-plan.md

---

## Goal

Build an interactive D3.js force-directed graph visualization of the user's skill repository. By end of Day 4: graph renders in the right panel from live Agent state, nodes are sized/colored by metadata, clicking a node shows skill detail, hover shows tooltip, and tag/usage filters work.

---

## Step 4.1 — Extract computeGraphData to src/graph.ts (1h)

The `computeGraphData()` method already exists inside `ChatAgent` in `src/server.ts` (from Day 1). Extract it to a standalone module so it can be tested independently and reused.

### 4.1a — Create src/graph.ts

```typescript
// src/graph.ts
import type { SkillMetadata, GraphNode, GraphEdge } from "./types";

export const TAG_COLORS: Record<string, string> = {
  architecture: "#f97316",
  frontend: "#3b82f6",
  backend: "#10b981",
  devops: "#8b5cf6",
  testing: "#ec4899",
  documentation: "#eab308",
  default: "#6b7280",
};

export function tagToColor(tag: string | undefined): string {
  if (!tag) return TAG_COLORS.default;
  return TAG_COLORS[tag.toLowerCase()] ?? TAG_COLORS.default;
}

export function computeGraphData(
  skills: SkillMetadata[]
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!skills.length) return { nodes: [], edges: [] };

  const nodes: GraphNode[] = skills.map((s) => ({
    id: s.name,
    tags: s.tags,
    size: Math.max(12, Math.log(s.usage_count + 1) * 12),
    color: tagToColor(s.tags[0]),
  }));

  const edges: GraphEdge[] = [];

  // Dependency edges (directed)
  for (const skill of skills) {
    for (const dep of skill.dependencies) {
      if (skills.some((s) => s.name === dep)) {
        edges.push({ source: skill.name, target: dep, type: "dependency" });
      }
    }
  }

  // Shared conversation edges (undirected, weighted)
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const shared = skills[i].source_conversations.filter((id) =>
        skills[j].source_conversations.includes(id)
      );
      if (shared.length > 0) {
        edges.push({
          source: skills[i].name,
          target: skills[j].name,
          type: "shared_conversation",
          weight: shared.length,
        });
      }
    }
  }

  return { nodes, edges };
}
```

### 4.1b — Update src/server.ts to use the extracted module

Replace the inline `computeGraphData()` method and `TAG_COLORS` constant in `ChatAgent` with an import:

```typescript
// At the top of src/server.ts, add:
import { computeGraphData } from "./graph";

// Then replace the private computeGraphData() method body with:
private computeGraphData(
  skills: SkillMetadata[]
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return computeGraphData(skills);
}
```

Remove the `TAG_COLORS` constant from `server.ts` — it now lives in `graph.ts`.

### 4.1c — Ensure computeGraphData is called after every skill CRUD operation

Search `src/server.ts` for every place a skill is saved, updated, or deleted. After each mutation, add a call to recompute and sync state:

```typescript
// After any skill INSERT, UPDATE, or DELETE:
private async syncGraphState(): Promise<void> {
  const skills = this.loadSkillMetadata();
  const graphData = this.computeGraphData(skills);
  this.setState({
    ...this.state,
    skills,
    graphData,
  });
}
```

Add `this.syncGraphState()` calls after:
- Skill save (approve flow)
- Skill update (refine → save)
- Skill delete (delete_skill message handler)

The `this.setState()` call automatically pushes the new state to all connected frontend clients via the WebSocket — no additional plumbing needed.

### Adaptation Notes

- `this.state` is the current `SkillForgeState` object. Spread it so you don't clobber other fields (ingestionStatus, pendingPatterns, draftSkill).
- `loadSkillMetadata()` already exists in `server.ts` — it reads from SQLite and parses JSON columns. Reuse it.
- If `this.state` is `undefined` on first call (Agent just started), default to the initial state shape from `types.ts`.

---

## Step 4.2 — Install D3 and Create SkillGraph Component (2.5h)

### 4.2a — Install D3

```bash
cd agents-starter
npm install d3 @types/d3
```

Verify `d3` and `@types/d3` appear in `agents-starter/package.json` (NOT the root `package.json`).

### 4.2b — Create src/components/SkillGraph.tsx

This is the core D3 force-directed graph component. It receives `graphData` from the parent (which gets it from `useAgent` state) and renders an interactive SVG.

```tsx
// src/components/SkillGraph.tsx
import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { Surface, Text, Badge } from "@cloudflare/kumo";
import { GraphIcon } from "@phosphor-icons/react";
import type { GraphNode, GraphEdge } from "../types";
import { TAG_COLORS } from "../graph";

// ── D3 simulation node type (extends GraphNode with x/y) ──
interface SimNode extends GraphNode {
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
  type: "dependency" | "shared_conversation";
  weight?: number;
}

interface SkillGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (nodeId: string) => void;
}

export function SkillGraph({ nodes, edges, onNodeClick }: SkillGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [tooltip, setTooltip] = useState<{
    node: GraphNode;
    x: number;
    y: number;
  } | null>(null);

  // ── Resize observer ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── D3 force simulation ──
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || nodes.length === 0) return;

    const { width, height } = dimensions;

    // Clear previous render
    d3.select(svg).selectAll("*").remove();

    // Deep-copy nodes and edges so D3 can mutate them
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }));
    const simEdges: SimEdge[] = edges.map((e) => ({ ...e }));

    // Build the SVG structure
    const svgSel = d3
      .select(svg)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`);

    // Add zoom behavior
    const g = svgSel.append("g");

    svgSel.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 3])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        })
    );

    // Arrow marker for dependency edges
    svgSel
      .append("defs")
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#6b7280");

    // Create simulation
    const simulation = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance(100)
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collide",
        d3.forceCollide<SimNode>().radius((d) => d.size + 5)
      );

    // Draw edges
    const edgeGroup = g
      .append("g")
      .attr("class", "edges")
      .selectAll("line")
      .data(simEdges)
      .join("line")
      .attr("stroke", "#404040")
      .attr("stroke-width", (d) =>
        d.type === "shared_conversation" ? Math.min((d.weight ?? 1) * 1.5, 5) : 1.5
      )
      .attr("stroke-dasharray", (d) =>
        d.type === "dependency" ? "6,3" : "none"
      )
      .attr("stroke-opacity", 0.6)
      .attr("marker-end", (d) =>
        d.type === "dependency" ? "url(#arrow)" : null
      )
      .on("mouseenter", function (_event, d) {
        d3.select(this)
          .attr("stroke", "#9ca3af")
          .attr("stroke-opacity", 1);
      })
      .on("mouseleave", function (_event, _d) {
        d3.select(this)
          .attr("stroke", "#404040")
          .attr("stroke-opacity", 0.6);
      });

    // Draw node groups
    const nodeGroup = g
      .append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(simNodes)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3
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
          })
      );

    // Node circles
    nodeGroup
      .append("circle")
      .attr("r", (d) => d.size)
      .attr("fill", (d) => d.color)
      .attr("fill-opacity", 0.85)
      .attr("stroke", "transparent")
      .attr("stroke-width", 2);

    // Node labels
    nodeGroup
      .append("text")
      .text((d) => d.id)
      .attr("text-anchor", "middle")
      .attr("dy", (d) => d.size + 14)
      .attr("fill", "#e5e5e5")
      .attr("font-size", "11px")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("pointer-events", "none");

    // Node interactions
    nodeGroup
      .on("click", (_event, d) => {
        onNodeClick(d.id);
      })
      .on("mouseenter", function (event, d) {
        d3.select(this).select("circle")
          .attr("stroke", "#e5e5e5")
          .attr("stroke-width", 2);

        // Show tooltip
        const svgRect = svg.getBoundingClientRect();
        setTooltip({
          node: d,
          x: (d.x ?? 0) + svgRect.left,
          y: (d.y ?? 0) + svgRect.top - d.size - 10,
        });
      })
      .on("mouseleave", function () {
        d3.select(this).select("circle")
          .attr("stroke", "transparent")
          .attr("stroke-width", 2);
        setTooltip(null);
      });

    // Tick handler — update positions each frame
    simulation.on("tick", () => {
      edgeGroup
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);

      nodeGroup.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    // Cleanup
    return () => {
      simulation.stop();
    };
  }, [nodes, edges, dimensions, onNodeClick]);

  // ── Empty state ──
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <GraphIcon size={48} className="text-kumo-inactive mb-4" />
        <Text size="lg" bold className="text-kumo-default mb-2">
          No skills yet
        </Text>
        <Text size="sm" variant="secondary">
          Ingest conversations to build your skill graph. Each skill becomes a
          node, and shared conversations or dependencies create edges.
        </Text>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ background: "transparent" }}
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          <Surface className="px-3 py-2 rounded-lg ring ring-kumo-line shadow-lg max-w-xs">
            <Text size="sm" bold className="text-kumo-default">
              {tooltip.node.id}
            </Text>
            <div className="flex flex-wrap gap-1 mt-1">
              {tooltip.node.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px]">
                  {tag}
                </Badge>
              ))}
            </div>
          </Surface>
        </div>
      )}
    </div>
  );
}
```

### 4.2c — Import note: GraphIcon

The `@phosphor-icons/react` package may not have `GraphIcon`. Check available icons:

```bash
cd agents-starter
grep -r "Graph" node_modules/@phosphor-icons/react/dist/icons/ --include="*.d.ts" -l | head -5
```

If `GraphIcon` is not available, use one of these alternatives:
- `GitBranchIcon` (git graph metaphor)
- `CirclesThreePlusIcon` (connected nodes)
- `TreeStructureIcon` (hierarchy)
- `FlowArrowIcon` (flow graph)

Import the icon that exists:

```tsx
// Replace GraphIcon with whichever is available:
import { TreeStructureIcon as GraphIcon } from "@phosphor-icons/react";
```

### Adaptation Notes

- **SVG, not Canvas**: SVG is used for easier DOM-based interactions (hover, click, drag). Canvas would be faster for 1000+ nodes but we expect <100 skills.
- **Zoom**: `d3.zoom()` is applied to the SVG so users can pan/zoom the graph.
- **Drag**: Nodes are draggable. During drag, the simulation reheats (`alphaTarget(0.3)`) so neighbors react.
- **Tooltip positioning**: Uses `getBoundingClientRect()` to position relative to the viewport, not the SVG. The `fixed` CSS positioning ensures it stays in place during scroll.
- **Dark theme**: Edge color `#404040`, label color `#e5e5e5`, background transparent (inherits `#0a0a0a` from parent).
- **Cleanup**: The `useEffect` returns a cleanup function that stops the simulation to avoid memory leaks when nodes/edges update.

---

## Step 4.3 — Node Styling: Size by Usage, Color by Tag (1h)

Node styling is already computed by the server in `computeGraphData()`. This step verifies it works correctly and adds visual refinements.

### 4.3a — Verify server-side computation

The `computeGraphData()` function (now in `src/graph.ts`) already handles:
- **Size**: `Math.max(12, Math.log(usage_count + 1) * 12)` — minimum radius 12px, scales logarithmically
- **Color**: First tag mapped through `TAG_COLORS`

No server changes needed. The following are client-side style refinements.

### 4.3b — Edge styling refinements

Edges are styled in Step 4.2b's D3 code. Verify these visual distinctions:

| Edge Type | Stroke | Dash | Arrow | Width |
|-----------|--------|------|-------|-------|
| `dependency` | `#404040` | `6,3` dashed | Yes (arrow marker) | 1.5px |
| `shared_conversation` | `#404040` | Solid | No | `weight * 1.5` (max 5px) |

### 4.3c — Add a legend component

Create a small legend overlay inside the graph panel showing what colors/shapes mean:

```tsx
// Add to src/components/SkillGraph.tsx (inside the component, below the SVG)

function GraphLegend() {
  return (
    <div className="absolute bottom-3 left-3 z-10">
      <Surface className="px-3 py-2 rounded-lg ring ring-kumo-line bg-kumo-base/80 backdrop-blur-sm">
        <Text size="xs" bold className="text-kumo-default mb-1.5">
          Tags
        </Text>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {Object.entries(TAG_COLORS)
            .filter(([key]) => key !== "default")
            .map(([tag, color]) => (
              <div key={tag} className="flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: color }}
                />
                <Text size="xs" variant="secondary">
                  {tag}
                </Text>
              </div>
            ))}
        </div>
        <div className="flex gap-3 mt-1.5 pt-1.5 border-t border-kumo-line">
          <div className="flex items-center gap-1.5">
            <span className="w-4 border-t border-dashed border-kumo-inactive" />
            <Text size="xs" variant="secondary">dependency</Text>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-4 border-t border-solid border-kumo-inactive" />
            <Text size="xs" variant="secondary">shared convo</Text>
          </div>
        </div>
      </Surface>
    </div>
  );
}
```

Then render `<GraphLegend />` inside the `SkillGraph` component's container div, alongside the SVG.

---

## Step 4.4 — Interactions: Click to Detail, Hover to Tooltip (1.5h)

### 4.4a — Click node triggers detail view

The `onNodeClick` prop is already wired in Step 4.2b. The parent component manages which view is shown (graph vs. detail). When a node is clicked:

1. `onNodeClick(nodeId)` fires
2. Parent sets `selectedSkill = nodeId` and switches right panel to "detail" view
3. The detail view shows the full skill definition

This wiring happens in Step 4.5 (right panel toggle).

### 4.4b — Enhanced tooltip with full metadata

The basic tooltip in Step 4.2b shows name and tags. Enhance it to include usage_count and description. This requires passing `skills` metadata (not just graphData) into the component.

Update `SkillGraphProps`:

```tsx
interface SkillGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  skills: SkillMetadata[];  // Full metadata for tooltips
  onNodeClick: (nodeId: string) => void;
}
```

Then update the tooltip rendering to look up the full skill:

```tsx
{tooltip && (() => {
  const skill = skills.find((s) => s.name === tooltip.node.id);
  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        transform: "translate(-50%, -100%)",
      }}
    >
      <Surface className="px-3 py-2 rounded-lg ring ring-kumo-line shadow-lg max-w-xs">
        <Text size="sm" bold className="text-kumo-default">
          {tooltip.node.id}
        </Text>
        {skill && (
          <Text size="xs" variant="secondary" className="mt-0.5 line-clamp-2">
            {skill.description}
          </Text>
        )}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {tooltip.node.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
        {skill && (
          <Text size="xs" variant="secondary" className="mt-1 text-kumo-inactive">
            Used {skill.usage_count} time{skill.usage_count !== 1 ? "s" : ""}
          </Text>
        )}
      </Surface>
    </div>
  );
})()}
```

### 4.4c — Edge hover feedback

Edge hover is already handled in Step 4.2b with `mouseenter`/`mouseleave` events that brighten the stroke. Optionally enhance with an edge tooltip:

```typescript
// In the edgeGroup event handlers (Step 4.2b), add tooltip logic:
.on("mouseenter", function (event, d) {
  d3.select(this)
    .attr("stroke", "#9ca3af")
    .attr("stroke-opacity", 1);

  // Edge tooltip (optional — can skip if cluttered)
  const midX = ((d.source as SimNode).x ?? 0 + (d.target as SimNode).x ?? 0) / 2;
  const midY = ((d.source as SimNode).y ?? 0 + (d.target as SimNode).y ?? 0) / 2;
  // Set an edge tooltip state if desired
})
```

If edge tooltips feel cluttered, the highlight-on-hover is sufficient for Day 4. Edge tooltips can be a Day 5 polish item.

---

## Step 4.5 — Right Panel Toggle: Graph / Skill Detail (1h)

### 4.5a — Update the layout to two-panel

The current `app.tsx` is a single-column chat UI. Convert it to the two-panel layout described in the design spec (Section 5): left panel (60%) for ingestion + chat, right panel (40%) for graph/detail.

Update the outermost layout in the `Chat` component:

```tsx
// Replace the current single-column layout with:
return (
  <div className="flex flex-col h-screen bg-kumo-elevated">
    {/* Header — full width */}
    <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
      {/* ... existing header content ... */}
    </header>

    {/* Two-panel body */}
    <div className="flex flex-1 overflow-hidden">
      {/* Left panel — ingestion + chat */}
      <div className="flex flex-col w-[60%] border-r border-kumo-line">
        {/* Ingestion panel (collapsible) */}
        <IngestionPanel agent={agent} />

        {/* Chat messages area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {/* ... existing message rendering ... */}
          </div>
        </div>

        {/* Chat input */}
        <div className="border-t border-kumo-line bg-kumo-base">
          {/* ... existing input form ... */}
        </div>
      </div>

      {/* Right panel — graph / detail */}
      <RightPanel
        state={agentState}
        onNodeClick={handleNodeClick}
        onBack={handleBackToGraph}
        selectedSkill={selectedSkill}
      />
    </div>
  </div>
);
```

### 4.5b — Consume Agent state for graph data

The `useAgent` hook already exists in `app.tsx`. Access state from it:

```tsx
// Inside the Chat component, after the useAgent hook:
const agentState = agent.state as SkillForgeState | undefined;
const graphData = agentState?.graphData ?? { nodes: [], edges: [] };
const skills = agentState?.skills ?? [];
```

Import `SkillForgeState` from `./types`.

### 4.5c — Create the RightPanel component

```tsx
// src/components/RightPanel.tsx
import { useState, useCallback } from "react";
import { Button, Text, Badge, Surface } from "@cloudflare/kumo";
import { ArrowLeftIcon, FunnelIcon } from "@phosphor-icons/react";
import { SkillGraph } from "./SkillGraph";
import { SkillPreview } from "./SkillPreview";
import { GraphFilters } from "./GraphFilters";
import type { SkillForgeState, SkillMetadata, GraphNode, GraphEdge } from "../types";

type PanelView = "graph" | "detail";

interface RightPanelProps {
  state: SkillForgeState | undefined;
  onNodeClick: (nodeId: string) => void;
  onBack: () => void;
  selectedSkill: string | null;
}

export function RightPanel({
  state,
  onNodeClick,
  onBack,
  selectedSkill,
}: RightPanelProps) {
  const [showFilters, setShowFilters] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [usageThreshold, setUsageThreshold] = useState(0);

  const graphData = state?.graphData ?? { nodes: [], edges: [] };
  const skills = state?.skills ?? [];
  const view: PanelView = selectedSkill ? "detail" : "graph";

  // Apply filters (dim, don't remove — see constraints)
  const filteredNodes = graphData.nodes.map((node) => {
    const skill = skills.find((s) => s.name === node.id);
    const matchesTag = !tagFilter || node.tags.includes(tagFilter);
    const matchesUsage = (skill?.usage_count ?? 0) >= usageThreshold;
    const dimmed = !matchesTag || !matchesUsage;
    return { ...node, dimmed };
  });

  const selectedSkillData = selectedSkill
    ? skills.find((s) => s.name === selectedSkill)
    : null;

  return (
    <div className="flex flex-col w-[40%] bg-kumo-elevated">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line bg-kumo-base">
        <div className="flex items-center gap-2">
          {view === "detail" && (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<ArrowLeftIcon size={16} />}
              onClick={onBack}
              aria-label="Back to graph"
            />
          )}
          <Text size="sm" bold>
            {view === "graph" ? "Skill Graph" : selectedSkillData?.name ?? "Skill Detail"}
          </Text>
          {view === "graph" && (
            <Badge variant="secondary">
              {graphData.nodes.length} skill{graphData.nodes.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        {view === "graph" && graphData.nodes.length > 0 && (
          <Button
            variant={showFilters ? "primary" : "secondary"}
            size="sm"
            icon={<FunnelIcon size={14} />}
            onClick={() => setShowFilters(!showFilters)}
          >
            Filter
          </Button>
        )}
      </div>

      {/* Filter controls (collapsible) */}
      {view === "graph" && showFilters && (
        <GraphFilters
          skills={skills}
          tagFilter={tagFilter}
          onTagFilterChange={setTagFilter}
          usageThreshold={usageThreshold}
          onUsageThresholdChange={setUsageThreshold}
        />
      )}

      {/* Panel body */}
      <div className="flex-1 overflow-hidden">
        {view === "graph" ? (
          <SkillGraph
            nodes={filteredNodes}
            edges={graphData.edges}
            skills={skills}
            onNodeClick={onNodeClick}
          />
        ) : (
          selectedSkillData && (
            <SkillPreview skill={selectedSkillData} />
          )
        )}
      </div>
    </div>
  );
}
```

### 4.5d — Add selectedSkill state to the Chat component

```tsx
// Inside the Chat component, add state:
const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

const handleNodeClick = useCallback((nodeId: string) => {
  setSelectedSkill(nodeId);
}, []);

const handleBackToGraph = useCallback(() => {
  setSelectedSkill(null);
}, []);
```

### 4.5e — Create or verify SkillPreview component

If `SkillPreview` already exists from Day 3 (task 3.7), import and reuse it. If not, create a minimal version:

```tsx
// src/components/SkillPreview.tsx
import { Badge, Text, Surface } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import type { SkillMetadata } from "../types";

interface SkillPreviewProps {
  skill: SkillMetadata;
}

export function SkillPreview({ skill }: SkillPreviewProps) {
  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="space-y-4">
        {/* Header */}
        <div>
          <Text size="lg" bold className="text-kumo-default">
            {skill.name}
          </Text>
          <Text size="sm" variant="secondary" className="mt-1">
            {skill.description}
          </Text>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap gap-2">
          {skill.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>

        <Surface className="px-3 py-2 rounded-lg ring ring-kumo-line">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <Text size="xs" variant="secondary">Version</Text>
              <Text size="xs" className="font-mono">{skill.version}</Text>
            </div>
            <div>
              <Text size="xs" variant="secondary">Usage Count</Text>
              <Text size="xs" className="font-mono">{skill.usage_count}</Text>
            </div>
            <div>
              <Text size="xs" variant="secondary">Created</Text>
              <Text size="xs" className="font-mono">
                {new Date(skill.created).toLocaleDateString()}
              </Text>
            </div>
            <div>
              <Text size="xs" variant="secondary">Last Used</Text>
              <Text size="xs" className="font-mono">
                {new Date(skill.last_used).toLocaleDateString()}
              </Text>
            </div>
          </div>
        </Surface>

        {/* Dependencies */}
        {skill.dependencies.length > 0 && (
          <div>
            <Text size="xs" bold variant="secondary" className="mb-1">
              Dependencies
            </Text>
            <div className="flex flex-wrap gap-1">
              {skill.dependencies.map((dep) => (
                <Badge key={dep} variant="secondary" className="font-mono text-[10px]">
                  {dep}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Trigger Patterns */}
        {skill.trigger_patterns.length > 0 && (
          <div>
            <Text size="xs" bold variant="secondary" className="mb-1">
              Trigger Patterns
            </Text>
            <ul className="space-y-1">
              {skill.trigger_patterns.map((pattern, i) => (
                <li key={i} className="text-xs text-kumo-subtle font-mono">
                  {pattern}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Adaptation Notes

- **Panel view state**: The view toggles between "graph" and "detail" based on `selectedSkill` being null or set. No explicit state machine needed — derive it.
- **`agent.state`**: The `useAgent` hook returns a `state` property that is automatically updated when the server calls `this.setState()`. Cast it to `SkillForgeState` on the frontend.
- **SkillPreview from Day 3**: If a richer SkillPreview exists from Day 3 (with skill content/markdown rendering), use that. The version above is a fallback.
- **Responsive**: On screens narrower than 768px, consider stacking left/right panels vertically. For Day 4, desktop-first is acceptable — mobile polish is Day 5.

---

## Step 4.6 — Filter Controls: Tag and Usage Threshold (1h)

### 4.6a — Create GraphFilters component

```tsx
// src/components/GraphFilters.tsx
import { Text, Badge, Button } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { TAG_COLORS } from "../graph";
import type { SkillMetadata } from "../types";

interface GraphFiltersProps {
  skills: SkillMetadata[];
  tagFilter: string | null;
  onTagFilterChange: (tag: string | null) => void;
  usageThreshold: number;
  onUsageThresholdChange: (threshold: number) => void;
}

export function GraphFilters({
  skills,
  tagFilter,
  onTagFilterChange,
  usageThreshold,
  onUsageThresholdChange,
}: GraphFiltersProps) {
  // Collect all unique tags from skills
  const allTags = Array.from(
    new Set(skills.flatMap((s) => s.tags))
  ).sort();

  // Compute max usage for slider range
  const maxUsage = Math.max(1, ...skills.map((s) => s.usage_count));

  return (
    <div className="px-4 py-3 border-b border-kumo-line bg-kumo-base space-y-3">
      {/* Tag filter chips */}
      <div>
        <Text size="xs" bold variant="secondary" className="mb-1.5">
          Filter by Tag
        </Text>
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => {
            const isActive = tagFilter === tag;
            const color = TAG_COLORS[tag.toLowerCase()] ?? TAG_COLORS.default;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagFilterChange(isActive ? null : tag)}
                className={`
                  inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                  border transition-colors cursor-pointer
                  ${
                    isActive
                      ? "border-kumo-accent bg-kumo-accent/10 text-kumo-default"
                      : "border-kumo-line bg-transparent text-kumo-subtle hover:border-kumo-inactive"
                  }
                `}
              >
                <span
                  className="w-2 h-2 rounded-full inline-block"
                  style={{ backgroundColor: color }}
                />
                {tag}
              </button>
            );
          })}
          {tagFilter && (
            <Button
              variant="ghost"
              size="sm"
              icon={<XIcon size={12} />}
              onClick={() => onTagFilterChange(null)}
              className="text-kumo-inactive"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Usage threshold slider */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Text size="xs" bold variant="secondary">
            Min. Usage Count
          </Text>
          <Text size="xs" variant="secondary" className="font-mono">
            {usageThreshold}
          </Text>
        </div>
        <input
          type="range"
          min={0}
          max={maxUsage}
          value={usageThreshold}
          onChange={(e) => onUsageThresholdChange(Number(e.target.value))}
          className="w-full h-1.5 bg-kumo-line rounded-full appearance-none cursor-pointer
                     [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:h-3.5
                     [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-kumo-accent
                     [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>
    </div>
  );
}
```

### 4.6b — Apply filter dimming in the D3 graph

The `filteredNodes` in `RightPanel` already compute a `dimmed` flag. Pass this through to `SkillGraph` and apply it visually.

Update the `GraphNode` type to support the dimmed flag in the graph component only (don't modify the shared type — add a local extended type):

```tsx
// Inside SkillGraph.tsx
interface DisplayNode extends GraphNode {
  dimmed?: boolean;
}

// Update SkillGraphProps:
interface SkillGraphProps {
  nodes: DisplayNode[];
  edges: GraphEdge[];
  skills: SkillMetadata[];
  onNodeClick: (nodeId: string) => void;
}
```

Then in the D3 node rendering, apply dimming:

```typescript
// Node circles — apply dimming via opacity
nodeGroup
  .append("circle")
  .attr("r", (d) => d.size)
  .attr("fill", (d) => d.color)
  .attr("fill-opacity", (d) => (d as DisplayNode).dimmed ? 0.15 : 0.85)
  .attr("stroke", "transparent")
  .attr("stroke-width", 2);

// Node labels — dim text too
nodeGroup
  .append("text")
  .text((d) => d.id)
  .attr("fill", (d) => (d as DisplayNode).dimmed ? "#404040" : "#e5e5e5")
  // ... rest of label attrs
```

Edges connected to dimmed nodes should also dim. Add this after the edge rendering:

```typescript
edgeGroup
  .attr("stroke-opacity", (d) => {
    const sourceNode = simNodes.find(
      (n) => n.id === ((d.source as SimNode).id ?? d.source)
    );
    const targetNode = simNodes.find(
      (n) => n.id === ((d.target as SimNode).id ?? d.target)
    );
    const sourceDimmed = (sourceNode as DisplayNode | undefined)?.dimmed;
    const targetDimmed = (targetNode as DisplayNode | undefined)?.dimmed;
    return sourceDimmed || targetDimmed ? 0.1 : 0.6;
  });
```

### Adaptation Notes

- **Dim, don't remove**: Filters dim nodes to 15% opacity rather than hiding them. This preserves spatial context — the graph layout doesn't collapse when filtering.
- **Tag chips**: The filter uses button-style chips, not a dropdown. More visual, faster to toggle. Each chip shows the tag color dot for quick identification.
- **Slider styling**: The `appearance-none` + webkit thumb styles create a custom slider that fits the dark theme. If kumo provides a Slider component, prefer that.
- **Max usage range**: Computed dynamically from current skills. If all skills have usage_count=0, the slider range is 0-1 (effectively no-op).

---

## Step 4.7 — Smoke Test (30min)

```bash
cd agents-starter
npm run dev
# Opens at http://localhost:5173
```

### Test Checklist

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | `npm run dev` starts | No build errors, no TypeScript errors from new files |
| 2 | Two-panel layout renders | Left panel (chat), right panel (graph) visible |
| 3 | Empty graph state | Right panel shows "No skills yet" message with icon |
| 4 | Ingest a conversation | After saving a skill, graph should show 1 node |
| 5 | Multiple skills | Ingest 2-3 conversations, graph shows multiple nodes |
| 6 | Node colors | Different tags produce different colored nodes |
| 7 | Node sizes | Skills with higher usage_count have larger circles |
| 8 | Edges render | Skills sharing conversations have connecting lines |
| 9 | Dependency edges | Skills with dependencies show dashed lines with arrows |
| 10 | Click node | Right panel switches to skill detail view |
| 11 | Back button | From detail view, "back" returns to graph view |
| 12 | Hover node | Tooltip shows name, description, tags, usage count |
| 13 | Hover edge | Edge brightens on hover |
| 14 | Drag node | Node follows mouse, neighbors react |
| 15 | Zoom/pan | Mouse wheel zooms, drag on background pans |
| 16 | Tag filter | Clicking a tag chip dims non-matching nodes |
| 17 | Usage filter | Moving slider dims low-usage nodes |
| 18 | Clear filter | Clearing tag filter restores all nodes |
| 19 | Live update | Saving a new skill adds a node without page refresh |
| 20 | `npm run check` passes | oxfmt + oxlint + tsc all pass |

---

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `Cannot find module 'd3'` | D3 not installed | Run `npm install d3 @types/d3` in `agents-starter/` |
| `d3 is not defined` in browser | D3 not bundled by Vite | Verify import is `import * as d3 from "d3"` (not a CDN script tag) |
| `Property 'state' does not exist` on agent | `useAgent` type mismatch | Cast: `const agentState = agent.state as SkillForgeState \| undefined` |
| Graph not updating when skills change | `syncGraphState()` not called | Add `this.syncGraphState()` after every skill INSERT/UPDATE/DELETE in server.ts |
| Nodes all stacked at origin | Simulation not ticking | Check that `simulation.on("tick", ...)` handler updates positions |
| TypeScript errors in D3 code | Missing `@types/d3` | Run `npm install @types/d3` |
| `GraphIcon` not found in phosphor | Icon name doesn't exist | Use `TreeStructureIcon` or `GitBranchIcon` instead |
| Tooltip positioned wrong | `getBoundingClientRect` called on wrong element | Ensure `svg.getBoundingClientRect()` is called on the SVG element, not the container |
| SVG overflows container | Missing `overflow: hidden` | Add `overflow-hidden` class to the container div |
| Dark mode colors invisible | Node/edge colors too dark | Verify edge color is `#404040` (not `#1a1a1a`), labels are `#e5e5e5` |
| Filters don't dim nodes | `dimmed` property not passed through | Check `filteredNodes` in RightPanel computes `dimmed` and SkillGraph reads it |
| D3 zoom conflicts with drag | Event propagation issue | D3 drag is applied to node groups, zoom to the SVG — they don't conflict if both use `.call()` |
| Memory leak on re-render | Simulation not stopped | Ensure `useEffect` cleanup calls `simulation.stop()` |
| `Cannot read properties of undefined` on edge source/target | D3 replaced string IDs with objects | After simulation, `edge.source` becomes a node object — access `.id` or `.x`/`.y` on it |

---

## File Inventory

After completing Day 4, these files should be new or modified:

| File | Status | Purpose |
|------|--------|---------|
| `src/graph.ts` | **NEW** | Extracted `computeGraphData()`, `TAG_COLORS`, `tagToColor()` |
| `src/components/SkillGraph.tsx` | **NEW** | D3 force-directed graph component |
| `src/components/RightPanel.tsx` | **NEW** | Right panel with graph/detail toggle |
| `src/components/SkillPreview.tsx` | **NEW** (or from Day 3) | Skill detail view |
| `src/components/GraphFilters.tsx` | **NEW** | Tag chips + usage slider |
| `src/server.ts` | **MODIFIED** | Import from `graph.ts`, add `syncGraphState()` |
| `src/app.tsx` | **MODIFIED** | Two-panel layout, selectedSkill state, RightPanel integration |
| `package.json` | **MODIFIED** | Added `d3` and `@types/d3` |

---

## Day 4 Definition of Done

- [ ] `computeGraphData()` extracted to `src/graph.ts` and tested (correct nodes/edges for 5+ skills)
- [ ] D3 dependency installed (`d3` + `@types/d3` in `agents-starter/package.json`)
- [ ] Force-directed graph renders in right panel with nodes and edges
- [ ] Node size scales with `usage_count`, color maps to primary tag
- [ ] Dependency edges are dashed with arrows, shared_conversation edges are solid with weight-based width
- [ ] Click node switches right panel to skill detail view
- [ ] Back button returns from detail to graph view
- [ ] Hover node shows tooltip with name, description, tags, usage count
- [ ] Hover edge highlights the edge
- [ ] Drag node repositions it, neighbors react
- [ ] Zoom and pan work on the graph
- [ ] Tag filter dims non-matching nodes (does not remove them)
- [ ] Usage threshold filter dims low-usage nodes
- [ ] Empty state shows "No skills yet" message
- [ ] Graph updates live when a skill is saved/deleted (no page refresh)
- [ ] Two-panel layout: left (60% — ingestion + chat), right (40% — graph/detail)
- [ ] Legend shows tag colors and edge types
- [ ] `npm run check` passes (oxfmt + oxlint + tsc)

**--> Ready for Day 5: Polish + README**
