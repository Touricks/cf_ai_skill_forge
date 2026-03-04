# Day 4 Test Plan — Graph Visualization

> Covers tasks 4.1–4.6 from sprint-plan.md
> Dependencies: Day 1 (Agent state sync) + Day 3 (skills exist in SQLite)
> Updated: 2026-03-03 (computeGraphData extracted to src/graph.ts, unit tests done)

---

## Unit Tests

### U4.1–U4.6 — computeGraphData() ✅ DONE

```
STATUS: 11 tests in test/graph.test.ts — ALL PASS
SOURCE: src/graph.ts (standalone exported function, extracted from server.ts)

Tests cover:
- U4.1: Zero skills → empty graph { nodes: [], edges: [] }
- U4.2: Each skill becomes a node (id === skill.name)
- U4.2: Node size scales with usage_count (logarithmic, min 12)
- U4.2: Node color mapped from primary tag (first tag in array)
- U4.2: Unknown tag gets default gray (#6b7280)
- U4.2: Empty tags gets default gray
- U4.3: Dependency creates directed edge { source, target, type: "dependency" }
- U4.3: Dependency to non-existent skill → no edge (no crash)
- U4.4: Two skills sharing source_conversations → shared_conversation edge with weight
- U4.4: Weight reflects count of shared conversations
- U4.4: No shared conversations → no edge

Known tag → color mappings tested:
  - "frontend" → #3b82f6 (blue)
  - "backend" → #10b981 (green)
```

---

## Integration Tests

### I4.1 — Graph data in Agent state (Task 4.1)

```
TEST: Saving a skill triggers graph recomputation in state
SETUP: Agent with 2 existing skills
RUN:   Save a 3rd skill (via approve flow)
CHECK: agent.state.graphData.nodes.length === 3
CHECK: agent.state.graphData includes edges if applicable
NOTE:  computeGraphData() called from handleApprove() in server.ts
PASS:  State auto-updates with new graph data

TEST: Deleting a skill removes it from graph
SETUP: Agent with 3 skills
RUN:   Delete 1 skill
CHECK: agent.state.graphData.nodes.length === 2
NOTE:  computeGraphData() called from handleDeleteSkill() in server.ts
PASS:  Graph reflects deletion
```

### I4.2 — State sync delivers graph to frontend (Task 4.1)

```
TEST: Frontend receives graphData via useAgent state sync
SETUP: Agent with skills, mock WebSocket client
RUN:   Trigger setState({ graphData })
CHECK: Client receives state with graphData.nodes and graphData.edges
PASS:  Graph data arrives at frontend without explicit fetch
```

### I4.3 — Right panel toggle state (Task 4.5)

```
NOTE: GraphView.tsx and SkillPreview.tsx not yet built — this test applies
      once those components are implemented.

TEST: Panel starts on graph view by default
CHECK: Right panel renders graph component (not skill detail)

TEST: Clicking a node switches to skill detail view
RUN:   Click event on graph node
CHECK: Right panel shows full skill markdown for that node

TEST: Clicking "back to graph" returns to graph view
RUN:   From detail view, click back/graph toggle
CHECK: Graph is re-rendered
PASS:  Toggle works bidirectionally (graph ↔ detail)
```

---

## Smoke Tests (Manual — Browser)

### S4.1 — Graph renders with real data (Task 4.2)

```
SETUP:  Have 5+ skills saved (or seed manually via SQLite)
RUN:    Open app, look at right panel
CHECK:  Force-directed graph is visible
CHECK:  5+ nodes rendered (not overlapping at origin)
CHECK:  Edges visible between connected nodes
CHECK:  Graph has settled into stable layout (not vibrating)
PASS:   D3 graph renders correctly with real skill data
```

### S4.2 — Node styling (Task 4.3)

```
CHECK:  Nodes have different sizes (larger = higher usage_count)
CHECK:  Nodes have different colors (based on primary tag)
CHECK:  Node labels (skill names) are readable
PASS:   Visual differentiation between nodes is clear
```

### S4.3 — Click node → skill detail (Task 4.4)

```
RUN:    Click on a graph node
CHECK:  Right panel switches to show full skill definition
CHECK:  Skill name, tags, version, content are all displayed
CHECK:  Clicking a different node switches to that skill
PASS:   Click interaction works
```

### S4.4 — Hover → tooltip (Task 4.4)

```
RUN:    Hover mouse over a graph node (don't click)
CHECK:  Tooltip appears showing: name, tags, usage_count, description
CHECK:  Tooltip disappears when mouse moves away
PASS:   Hover metadata tooltip works
```

### S4.5 — Edge interactions (Task 4.4)

```
RUN:    Hover over an edge
CHECK:  Edge brightens or highlights
CHECK:  Tooltip or label shows relationship type (dependency vs shared conversation)
PASS:   Edge hover feedback works
```

### S4.6 — Filter by tag (Task 4.6)

```
RUN:    Select a tag from filter controls (e.g., "frontend")
CHECK:  Only nodes with that tag remain highlighted or visible
CHECK:  Edges to/from hidden nodes are dimmed or hidden
CHECK:  Clearing filter restores all nodes
PASS:   Tag filter works
```

### S4.7 — Filter by usage threshold (Task 4.6)

```
RUN:    Set minimum usage threshold (e.g., usage_count >= 2)
CHECK:  Skills with 0-1 usage are dimmed or hidden
CHECK:  Remaining skills stay visible and interactive
PASS:   Usage filter works
```

### S4.8 — Graph updates live (Task 4.1)

```
RUN:    With graph visible, go to chat and approve a new skill
CHECK:  Graph adds the new node without full page refresh
CHECK:  New edges appear if the skill shares conversations with existing skills
PASS:   Live graph update via state sync
```

### S4.9 — Empty graph state (Task 4.2)

```
SETUP:  Delete all skills (or use fresh Agent instance)
CHECK:  Right panel shows empty state (e.g., "No skills yet. Ingest conversations to build your skill graph.")
CHECK:  No JavaScript errors in console
PASS:   Graceful empty state
```

---

## Day 4 Gate (must pass before Day 5)

| # | Criterion | Test |
|---|-----------|------|
| G4.1 | computeGraphData() correct for 5+ skills | U4.1–U4.6 ✅ |
| G4.2 | Graph data updates in state on skill CRUD | I4.1 |
| G4.3 | D3 graph renders in browser with 5+ nodes | S4.1 |
| G4.4 | Click node → shows skill detail | S4.3 |
| G4.5 | Hover node → shows tooltip | S4.4 |
| G4.6 | At least one filter works (tag or usage) | S4.6 or S4.7 |
| G4.7 | Graph updates live when skill is saved | S4.8 |

**All 7 gates must pass. If any fail, do not proceed to Day 5.**
