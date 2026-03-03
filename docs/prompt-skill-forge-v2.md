# Skill Forge — AI-Powered Skill Distillation & Management Copilot (v2)

> **v2 changelog:** Revised architecture to use Cloudflare Agents SDK + Workflows.
> Eliminated D1/KV in favor of Agent's embedded SQLite. Added explicit
> frontend-backend message contract. Compressed Day 1 timeline.

---

## 1. Persona and Audience

- **AI Role**: A developer skill architect — an expert at analyzing scattered AI conversations, identifying reusable patterns, and distilling them into structured, version-controlled skill definitions. Speaks like a senior engineering teammate: direct, efficient, always suggesting the next concrete step.
- **Target Audience**: Developers who heavily use AI assistants (Claude, ChatGPT, Gemini) and have accumulated valuable problem-solving patterns across hundreds of conversations, but lack a systematic way to capture, organize, and reuse them.
- **Reviewer Audience** (meta): Cloudflare hiring committee evaluating idiomatic use of the Agents SDK, Workflows, Workers AI, and Pages.

---

## 2. Core Objective and Deliverable

- **Task Goal**: Build a Cloudflare-native AI application that transforms fragmented AI conversation history into a structured, searchable, graph-visualized skill repository with rich metadata.
- **Delivery Format**: Full-stack web application deployed entirely on Cloudflare's platform.
- **Three Core Capabilities**:
  1. **Distill**: Ingest conversation exports (paste or upload), analyze across multiple sessions, extract reusable skill patterns, and draft structured skill definitions.
  2. **Manage**: Maintain a persistent skill repository with rich metadata (triggers, dependencies, tags, usage tracking) — searchable and self-organizing.
  3. **Visualize**: Render the skill repository as an interactive graph/network view — skills as nodes, source conversations as edges, clusters by tag/domain.
- **Success Criteria**:
  - User can paste/upload 3+ conversation excerpts and the app synthesizes them into 1 structured skill file
  - Skills persist across browser sessions (close tab, reopen, skills are still there)
  - Graph view renders skill relationships interactively
  - All 4 Cloudflare assignment components (LLM, Workflow, Chat UI, Memory) are demonstrably and idiomatically used

---

## 3. Data Grounding and External Inputs

- **Input Sources**:
  - **MVP**: User pastes conversation excerpts directly into chat, or uploads exported markdown/JSON chat files
  - **Stretch Goal**: Browser bookmarklet that captures current AI conversation page and POSTs to the Agent's HTTP endpoint
- **Factual Constraints**:
  - The LLM must ONLY extract patterns that are explicitly present in the provided conversations — no hallucinated skill definitions
  - When synthesizing across multiple conversations, the copilot must cite which conversation(s) each extracted pattern came from
  - If the provided conversations are insufficient to form a complete skill, the copilot must flag specific gaps and ask the user to provide additional context
- **Skill Output Schema** (fixed format, non-negotiable):

```yaml
---
name: [kebab-case-skill-name]
description: "[One-line trigger description for when this skill should activate]"
tags: [tag1, tag2, tag3]
dependencies: [dependency1, dependency2]
version: [semver]
created: [ISO 8601 date]
last_used: [ISO 8601 date]
usage_count: [integer]
source_conversations: [list of conversation IDs/titles that contributed]
trigger_patterns:
  - "[pattern 1 — user intent or keyword that should activate this skill]"
  - "[pattern 2]"
---

# [Skill Title]

## Overview
[2-3 sentence summary of what this skill does and when to use it]

## When to Use
[Bullet list of specific trigger scenarios]

## Process
[Step-by-step instructions the AI should follow]

## Anti-Patterns
[What NOT to do — common mistakes this skill prevents]

## Examples
[At least one concrete input/output example]
```

---

## 4. Information Density and Writing Style

- **Copilot Communication Style**: Conversational but efficient — brief explanation of what it found/did, then immediate next step. No filler, no over-explanation.
- **Density**: Prefer structured output (tables, bullet points, schema blocks) over prose when presenting skill analysis. Prose only for conversational turns.
- **Tone**: Senior teammate — direct, opinionated when helpful, never condescending. Says "I found 3 patterns across your conversations, here's my draft — what would you change?" not "I'd be happy to help you analyze your conversations!"
- **Forbidden**:
  - No hedging language ("perhaps", "maybe", "it might be worth considering")
  - No restating the user's input back to them
  - No generic advice — every response must reference specific content from the user's provided conversations

---

## 5. Visual and Design System

- **Overall Aesthetic**: Developer-tool minimal — dark mode default, monospace accents, clean grid layout. Think Linear or Raycast, not Notion. Built with Tailwind CSS v4 + `@cloudflare/kumo` component library (Surface, Button, Badge, InputArea, Text, Empty, Switch).
- **Layout — Two-Panel Architecture**:
  - **Left panel** (60% width) — two distinct zones stacked vertically:
    - **Ingestion zone** (top, collapsible): Dedicated area for submitting AI conversation records. Contains a large text area for paste input, a drag-and-drop file upload region, and a "Start Analysis" button. Displays ingestion status (progress indicator, error messages) independently from chat. Collapses to a slim bar with "＋ Ingest Conversation" trigger when not in use. This zone sends `ingest` messages — completely decoupled from the chat input.
    - **Chat zone** (bottom, fills remaining space): Multi-turn conversation with the copilot for general Q&A, skill refinement feedback, search queries, and approvals. Managed by `useAgentChat` from `@cloudflare/ai-chat/react` — message persistence, streaming, and tool calls are handled by the framework. Refine, search, and list are registered as `tool()` definitions, invoked naturally through conversation.
  - **Right panel** (40% width) — toggles between:
    - **Graph view**: Interactive network visualization of skills (D3.js or similar)
    - **Skill detail**: Full rendered skill definition when a node is selected
    - **Ingestion preview**: Parsed conversation highlights during distillation (auto-activates when ingestion zone is active)
  - **Why separate ingestion from chat**: (1) Pasting multi-thousand-line conversation dumps into a chat input is poor UX — a dedicated text area with file drop handles this cleanly. (2) Ingestion status (running/complete/error) needs persistent visibility, not buried in scrolling chat history. (3) Users can continue chatting with the copilot while a background ingestion runs. (4) The backend already separates these flows — `onChatMessage` handles chat (via `useAgentChat`), `onMessage` handles the ingestion protocol (via `useAgent`) — the UI should reflect this separation.
- **Graph Visualization Spec**:
  - Nodes = Skills (sized by usage_count, colored by primary tag)
  - Edges = Shared source conversations or declared dependencies
  - Clusters = Tag-based grouping with force-directed layout
  - Interactive: Click node to show skill detail in right panel; hover to show metadata tooltip
  - **Data flow**: Agent computes graph data from `this.sql`, includes it in `this.setState()`. Frontend receives updates automatically via `useAgent` hook — no separate API polling needed.
- **Color Palette**:
  - Background: `#0a0a0a` (near-black)
  - Primary text: `#e5e5e5` (light gray)
  - Accent: `#f97316` (Cloudflare orange — subtle nod to the platform)
  - Node colors: Tag-based categorical palette (muted tones)
  - Edges: `#404040` (subtle gray, brighten on hover)
- **Typography**:
  - UI/chat: Inter or system sans-serif, 14px base
  - Code/schema blocks: JetBrains Mono or Fira Code, 13px
- **Responsive**: Desktop-first (reviewer will likely test on desktop), but chat panel should stack above graph on mobile

---

## 6. Modular Micro-Structure

### Architecture Overview

Two server-side components with clear separation of concerns:

```
┌─────────────────────────────────────────────────────┐
│  ChatAgent (extends AIChatAgent<Env>)                │
│                                                       │
│  Chat channel (onChatMessage):                        │
│  - streamText() with SYSTEM_PROMPT + domain tools     │
│  - Tools: searchSkills, listSkills, refineSkill       │
│  - Streaming via Vercel AI SDK toUIMessageStream      │
│  - Message persistence managed by AIChatAgent         │
│                                                       │
│  Ingestion channel (onMessage):                       │
│  - Custom protocol: ingest, confirm_patterns, approve │
│  - Triggers Workflow, sends results to client         │
│                                                       │
│  Shared:                                              │
│  - Skill repository (this.sql)                        │
│  - State sync to frontend (this.setState)             │
│  - Graph data computation                             │
│                                                       │
│  Storage: embedded SQLite via this.sql                │
│  Communication: useAgentChat (chat) + useAgent (rest) │
└──────────────────┬────────────────────────────────────┘
                   │ this.env.INGESTION_WORKFLOW.create(...)
                   ▼
┌─────────────────────────────────────────────────────┐
│  IngestionPipeline (Cloudflare Workflow)              │
│                                                       │
│  Step 1: Chunk conversation (non-LLM)                │
│  Step 2: Extract patterns — Prompt 1 (per chunk)      │
│  Step 3: Crossref existing skills — Prompt 2          │
│  Step 4: Generate draft skill — Prompt 3              │
│                                                       │
│  LLM calls: raw env.AI.run() (not streamText)        │
│  Each step: automatic retry on failure                │
│  Final: callback to Agent with results                │
└─────────────────────────────────────────────────────┘
```

**Why this split:**
- The Agent handles everything real-time (chat, state, UI sync) — it needs WebSocket, persistent state, and zero-latency SQL.
- The Workflow handles the ingestion pipeline — it needs step isolation, automatic retry, and durable execution guarantees. If Workers AI rate-limits or returns garbage, the Workflow retries the step without losing prior work.
- This is not checkbox engineering — each component is used for what it's architecturally designed to do.

### Module A — Ingestion Pipeline (Cloudflare Workflow)

```typescript
// Simplified Workflow structure
export class IngestionPipeline extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent, step: WorkflowStep) {
    const { conversationText, agentId } = event.payload;

    // Step 1: Chunk (non-LLM, fast, no retry needed)
    const chunks = await step.do("chunk-conversation", async () => {
      return chunkConversation(conversationText);
    });

    // Step 2: Extract patterns from each chunk (LLM, needs retry)
    const allPatterns = await step.do("extract-patterns", {
      retries: { limit: 2, backoff: "exponential" },
    }, async () => {
      const patterns = [];
      for (const chunk of chunks) {
        const result = await callWorkersAI(this.env.AI, EXTRACT_PROMPT, chunk);
        patterns.push(...JSON.parse(result));
      }
      return deduplicatePatterns(patterns);
    });

    // Step 3: Crossref against existing skills (LLM, needs retry)
    const verdicts = await step.do("crossref-skills", {
      retries: { limit: 2, backoff: "exponential" },
    }, async () => {
      const existingSkills = await fetchSkillSummaries(agentId);
      return JSON.parse(
        await callWorkersAI(this.env.AI, CROSSREF_PROMPT, {
          existing: existingSkills,
          new_patterns: allPatterns,
        })
      );
    });

    // Step 4: Draft skill for confirmed "new" patterns (LLM, needs retry)
    const drafts = await step.do("draft-skills", {
      retries: { limit: 2, backoff: "exponential" },
    }, async () => {
      const newPatterns = verdicts.filter(v => v.verdict === "new");
      const results = [];
      for (const pattern of newPatterns) {
        const draft = await callWorkersAI(this.env.AI, DRAFT_PROMPT, pattern);
        results.push(draft);
      }
      return results;
    });

    // Return results — Agent picks these up
    return { patterns: allPatterns, verdicts, drafts };
  }
}
```

**Retry rationale:** Workers AI calls to Llama 3.3 70B can fail due to rate limiting, timeout, or malformed output. Workflow steps retry automatically with exponential backoff — this is something the Agent class cannot do natively.

### Module B — Skill Drafting and Refinement (Agent)

- Lives in the Agent because it's interactive — user reviews draft in chat, gives feedback, the LLM refines.
- This is a real-time back-and-forth loop, not a batch pipeline. The Agent's WebSocket connection is essential.
- **Refine and Search are registered as `tool()` definitions** in the Agent's `streamText()` call, not custom WebSocket message types. The user invokes them naturally through conversation (e.g., "refine the React Hooks skill to include more examples"), and the LLM calls the appropriate tool.
- Uses Prompt 4 (Refine) iteratively until user approves.
- On approval, writes finalized skill to `this.sql` and updates `this.setState` (which auto-syncs graph data to frontend).

### Module C — Skill Repository (Agent's Embedded SQLite)

Single storage layer via `this.sql`. No D1, no KV.

**SQL Schema:**

```sql
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,              -- JSON array as text
  dependencies TEXT DEFAULT '[]',  -- JSON array as text
  version TEXT DEFAULT '1.0.0',
  created TEXT NOT NULL,
  last_used TEXT NOT NULL,
  usage_count INTEGER DEFAULT 0,
  source_conversations TEXT DEFAULT '[]',  -- JSON array
  trigger_patterns TEXT DEFAULT '[]',      -- JSON array
  content TEXT NOT NULL                     -- Full skill markdown
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  ingested_at TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  extracted_patterns TEXT  -- JSON array from Prompt 1
);

CREATE TABLE IF NOT EXISTS conversation_skill_links (
  conversation_id TEXT REFERENCES conversations(id),
  skill_name TEXT REFERENCES skills(name),
  PRIMARY KEY (conversation_id, skill_name)
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
```

**Why embedded SQLite, not D1 + KV:**
- Zero-latency reads and writes — the database is colocated with the Agent instance, not across the network.
- Each Agent instance (= each user) has its own isolated database. No multi-tenant query filtering.
- Simplifies the codebase: one storage API (`this.sql`) instead of three (D1 client + KV client + DO state).
- Graph queries (`SELECT name, tags, dependencies FROM skills`) run in microseconds, making real-time graph rendering trivial.

**Tradeoff acknowledged:** If a user's skill repository grows to thousands of skills with very long markdown content, SQLite row size could become a concern. For the MVP, this is not a realistic bottleneck. If it becomes one, large content blobs can be moved to R2.

### Module D — Graph Visualization Engine

- **Data source**: Computed from `this.sql` queries, pushed to frontend via `this.setState`.
- **Computation**: When any skill is created/updated/deleted, Agent recomputes graph data:

```typescript
// Inside ChatAgent (extends AIChatAgent):
recomputeGraphData() {
  const skills = this.sql<SkillNode>`
    SELECT name, tags, dependencies, usage_count, source_conversations
    FROM skills`;

  const nodes = skills.map(s => ({
    id: s.name,
    tags: JSON.parse(s.tags),
    size: Math.max(10, Math.log(s.usage_count + 1) * 10),
    color: tagToColor(JSON.parse(s.tags)[0]),
  }));

  const edges: GraphEdge[] = [];

  // Dependency edges
  for (const skill of skills) {
    for (const dep of JSON.parse(skill.dependencies)) {
      edges.push({ source: skill.name, target: dep, type: "dependency" });
    }
  }

  // Shared-conversation edges
  for (const skill of skills) {
    const convIds = JSON.parse(skill.source_conversations);
    for (const other of skills) {
      if (other.name === skill.name) continue;
      const otherConvIds = JSON.parse(other.source_conversations);
      const shared = convIds.filter((id: string) => otherConvIds.includes(id));
      if (shared.length > 0) {
        edges.push({
          source: skill.name,
          target: other.name,
          type: "shared_conversation",
          weight: shared.length,
        });
      }
    }
  }

  this.setState({ ...this.state, graphData: { nodes, edges } });
  // Frontend receives this automatically via useAgent
}
```

- **Rendering**: Client-side D3.js force-directed graph on Pages.
- **Interactions**: Click node → show skill detail; hover → metadata tooltip; click edge → show shared conversation; filter by tag/date/usage.

### Module E — Chat Interface, Ingestion Panel, and Frontend-Backend Contract

**Frontend stack:** React 19 on Cloudflare Pages, built with Vite 7 + `@cloudflare/vite-plugin`. UI uses `@cloudflare/kumo` components + Tailwind CSS v4.

**Dual-channel connection setup:**

The app uses **two communication channels** on one WebSocket connection:

1. **Chat channel** — `useAgentChat` ↔ `onChatMessage()` — fully managed by the `@cloudflare/ai-chat` framework (messages, streaming, tools, persistence)
2. **Ingestion channel** — `useAgent` ↔ `onMessage()` — custom protocol for ingestion panel operations

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

// Raw WebSocket connection (used for ingestion messages + connection state)
const agent = useAgent({
  agent: "ChatAgent",
  onOpen: () => setConnected(true),
  onClose: () => setConnected(false),
  onMessage: (msg) => {
    // Handle ingestion-channel responses:
    // patterns_extracted, skill_drafted, ingestion_started, error
  },
});

// Chat channel (layered on top of the same WebSocket)
const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
  agent,
  // Tools (searchSkills, refineSkill, listSkills) are server-side —
  // invoked automatically by the LLM, no client-side handling needed
});
```

**Two UI entry points, one WebSocket connection:**

```
┌─ Left Panel ─────────────────────────────────────────┐
│                                                       │
│  ┌─ IngestionPanel (collapsible) ───────────────────┐ │
│  │  <textarea> or drag-and-drop file zone           │ │
│  │  [Start Analysis] → agent.send({ type: "ingest" })│
│  │  Status bar: idle | running (progress) | done     │ │
│  │  Pattern cards (from onMessage responses)         │ │
│  │  [Confirm] → agent.send({ type: "confirm_patterns" })│
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─ ChatPanel (managed by useAgentChat) ────────────┐ │
│  │  Message list (from useAgentChat messages)        │ │
│  │  Tool calls rendered automatically (kumo UI)      │ │
│  │  Streaming via Streamdown markdown renderer       │ │
│  │  Input → sendMessage({ role: "user", parts: [...] })│
│  └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

**Message contract — Ingestion channel only:**

Chat messages (send, stream, tool calls, history) are fully managed by `useAgentChat` ↔ `onChatMessage`. No custom message types needed for chat. Refine, search, and list are `tool()` definitions invoked naturally through conversation.

The following custom message types are for the **ingestion channel only** (`useAgent.send` ↔ `onMessage`):

| Direction | Type | Payload | Description |
|-----------|------|---------|-------------|
| Client → Agent | `ingest` | `{ content: string }` | Paste/upload conversation text |
| Client → Agent | `confirm_patterns` | `{ patterns: Pattern[] }` | Confirm which patterns to proceed |
| Client → Agent | `approve` | `{ skillName: string }` | Approve final skill |
| Client → Agent | `delete_skill` | `{ skillName: string }` | Remove skill |
| Agent → Client | `ingestion_started` | `{ workflowId: string }` | Pipeline triggered |
| Agent → Client | `ingestion_progress` | `{ step: string, pct: number }` | Pipeline step progress |
| Agent → Client | `patterns_extracted` | `{ patterns: Pattern[] }` | Results ready for review |
| Agent → Client | `skill_drafted` | `{ markdown: string }` | Draft ready for review |
| Agent → Client | `error` | `{ message: string }` | Error |

**State sync (automatic via `useAgent` setState):**

State changes from `this.setState` are pushed automatically. Note: **chat state is NOT in this object** — it's managed internally by `AIChatAgent`/`useAgentChat`.

```typescript
interface SkillForgeState {
  // --- Ingestion Panel state ---
  ingestionStatus: "idle" | "running" | "complete" | "error";
  ingestionStep: string | null;      // Current pipeline step name (for progress display)
  pendingPatterns: Pattern[];        // Drives pattern confirmation cards in Ingestion Panel

  // --- Right Panel state ---
  skills: SkillMetadata[];           // Drives skill list and graph
  graphData: { nodes, edges };       // Drives D3 visualization
  draftSkill: string | null;         // Drives skill preview card in Right Panel
}
```

**HTTP endpoints (onRequest — secondary, for non-realtime operations):**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload` | File upload (multipart form data) |
| GET | `/api/skills/:name/export` | Download skill as .md file |
| GET | `/api/health` | Health check for monitoring |

---

## 7. Medium-Specific Technical Rules

### Cloudflare-Native Stack

| Component | Service | Architectural Reason |
|-----------|---------|---------------------|
| LLM Inference | Workers AI (`llama-3.3-70b-instruct-fp8-fast`) | On-edge inference, no external API keys needed |
| Agent Framework | `AIChatAgent` from `@cloudflare/ai-chat` (extends Agent SDK) | Built-in chat message persistence, streaming, tool handling via `onChatMessage` |
| AI SDK | Vercel `ai` package (`streamText`, `tool`, `UIMessage`) | Unified LLM interaction: streaming, tool definitions, message conversion |
| Real-time State + Chat | Agent SDK Durable Objects | WebSocket, embedded SQLite, auto state sync — persistent connection + zero-latency storage |
| Ingestion Pipeline | Cloudflare Workflows | Multi-step LLM chain with automatic retry — step isolation and durable execution |
| Skill Storage | Agent's embedded SQLite (`this.sql`) | Colocated with compute, zero-latency reads for graph rendering |
| Frontend | Vite 7 + `@cloudflare/kumo` + `useAgentChat` (chat) + `useAgent` (ingestion) | Kumo design system + dual-channel WebSocket |
| Build | Vite 7 + `@cloudflare/vite-plugin` | HMR dev server, Cloudflare-aware builds |
| File Storage | R2 (stretch goal only) | Large file uploads if conversation exports exceed SQLite row limits |

### Technical Constraints

- **Workers AI model limits**: Verify actual context window and rate limits for `llama-3.3-70b-instruct-fp8-fast` at https://developers.cloudflare.com/workers-ai/models/ during Day 1. Chunk conversations conservatively (2500 tokens/chunk) until verified.
- **Agent SQLite limits**: SQLite rows have no hard size limit, but performance degrades with very large TEXT columns. Keep skill markdown under ~100KB per skill (practical for any real skill definition).
- **Workflow step timeout**: Individual Workflow steps have execution time limits. If a single LLM call takes too long, the step will timeout and retry. Use the `fp8-fast` model variant to minimize latency.
- **State sync payload size**: `this.setState` syncs the full state object to all connected clients. Keep `graphData` under 500KB (practical for hundreds of skills, problematic for thousands — address in v2 if needed).
- **Streaming**: Agent chat uses Vercel AI SDK `streamText()` → `toUIMessageStreamResponse()`, consumed by `useAgentChat` + `Streamdown` renderer on the frontend. Workflow steps use raw `env.AI.run()` (non-streaming batch processing).

### Sprint Timeline (3-5 days)

| Day | Focus | Deliverables | Hours |
|-----|-------|-------------|-------|
| 1 (half day) | **Scaffold + Agent skeleton** | Extend existing agents-starter `AIChatAgent`: switch model, override `onChatMessage` with SYSTEM_PROMPT + domain `tool()` definitions, add `onMessage` for ingestion protocol, add `onStart` SQL schema, add Workflow binding, add IngestionPanel alongside kumo chat. `npm run check` passes. | 4-5h |
| 2 (full day) | **Ingestion pipeline (highest risk)** | `IngestionPipeline` Workflow with all 4 steps. Prompt 1 (Extract) + Prompt 2 (Crossref) + Prompt 3 (Draft) tested with real conversation data. Retry logic verified. Results flowing back to Agent and displayed in chat. | 8h |
| 3 (full day) | **Refinement loop + Skill repo** | Prompt 4 (Refine) interactive loop in chat. Skill CRUD in SQLite. Prompt 5 (Search) working. Command shortcuts (`/ingest`, `/search`, `/skill`). Chat history persistence. | 8h |
| 4 (full day) | **Graph visualization** | D3.js force-directed graph. Node interactions (click, hover). Edge rendering. Tag-based clustering. Filter controls. Graph data computed from SQL and synced via setState. | 8h |
| 5 (half day) | **Polish + README** | Error handling, loading states, empty states. File upload drag-and-drop. README explaining architecture decisions (why Agent + Workflow, why embedded SQLite, why not D1/KV). | 4-5h |

**Key shift from v1:** Day 1 is compressed from a full day to a half day. The saved time is redistributed to Day 2 (pipeline — highest risk) and Day 4 (graph — highest visual impact).

---

## 8. Top-Tier Quality Bar

- **Benchmark**: The application should feel like an early-stage developer tool product (think Linear v0.1 or Raycast beta) — opinionated, fast, clearly useful, rough edges acceptable but core loop must be solid.
- **Acceptance Criteria**:
  - A reviewer can paste 2-3 conversation excerpts and get a structured skill definition within 60 seconds
  - Skills persist across browser sessions (close tab, reopen, skills are still there)
  - Graph view renders with at least 5 skills and shows meaningful relationships
  - Chat feels responsive (streaming responses, no blank loading screens)
  - Every Cloudflare component (Workers AI, Agent SDK, Workflows, Pages) is used for an architecturally justified reason — not bolted on
  - Code is clean enough that a reviewer can understand the architecture in 10 minutes of reading
- **Disqualifying Flaws**:
  - Skills don't persist (memory requirement not met)
  - LLM is called but does nothing meaningful (checkbox integration)
  - No real workflow orchestration (just a single API call with no step isolation or retry)
  - UI is a bare HTML form with no thought given to interaction design
- **Differentiators That Would Stand Out**:
  - The graph visualization actually reveals useful relationships (not just eye candy)
  - The skill schema is thoughtfully designed with real trigger patterns
  - The ingestion pipeline handles edge cases (incomplete conversations, conflicting patterns across sessions, LLM returning invalid JSON)
  - README explains architectural decisions, not just setup instructions
  - README explicitly addresses: "Why Agent + Workflows instead of just Workflows? Why embedded SQLite instead of D1 + KV?"
