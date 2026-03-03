Good — this is a significant discovery. The starter template has evolved well beyond what our docs assumed. Let me do a precise diff analysis.I have enough context from all three files plus the two uploads. Here's the precise analysis.

---

## Impact Assessment: What Actually Changed

The PROGRESS.md reveals the starter template has **three layers of abstraction** we didn't account for:

| Layer | We Assumed | Reality | Impact |
|-------|-----------|---------|--------|
| **Agent class** | Raw `Agent<Env, State>` with manual `onMessage` | `AIChatAgent<Env>` with built-in `onChatMessage` + message persistence | **HIGH** — Agent class code is 70% different |
| **LLM calls** | Raw `env.AI.run()` + manual SSE parsing | Vercel AI SDK `streamText()` + `tool()` | **HIGH** — All LLM call patterns change |
| **Frontend** | Raw `useAgent` + custom React + inline CSS | `useAgentChat` + `@cloudflare/kumo` + Tailwind v4 | **HIGH** — Frontend code is 90% different |
| **Build** | `wrangler dev` | Vite 7 + `@cloudflare/vite-plugin` | **LOW** — just use `npm run dev` |
| **Message format** | Custom `{ type, content }` JSON | Vercel AI SDK `UIMessage` with parts | **MEDIUM** — Chat messages auto-handled, but ingestion messages still need custom protocol |

### What Does NOT Change

These parts of our design are still correct:

- **Workflow architecture** (IngestionPipeline with 4 steps + auto-retry) — Workflows are independent of the Agent class choice
- **SQL schema** (4 tables: skills, conversations, conversation_skill_links, chat_history) — `this.sql` works the same on `AIChatAgent`
- **All 5 prompt templates** (Extract, Crossref, Draft, Refine, Search) — content is LLM-facing, not framework-facing
- **Graph computation logic** (`computeGraphData()`) — pure function, no framework dependency
- **Skill schema** (YAML frontmatter + markdown sections) — domain model, unchanged
- **Sprint timeline structure** (5 days, same risk ordering) — though Day 1 tasks shift

---

## Update Plan: 3 Documents × Specific Changes

### Document 1: `prompt-skill-forge-v2.md` — 4 sections need revision

**§6 Module E — Chat Interface Contract (lines 333-391)**

This section is the most impacted. Current version describes raw `useAgent` + custom message types. Needs rewrite:

| Current | Updated |
|---------|---------|
| `useAgent` from `agents/react` | `useAgentChat` from `@cloudflare/ai-chat/react` for chat; raw `useAgent` only for ingestion state sync |
| 12-row custom message contract table | Split into two channels: (1) Chat channel — handled automatically by `useAgentChat`/`onChatMessage`, no custom messages needed; (2) Ingestion channel — custom WebSocket messages via `onMessage` for non-chat operations |
| `SkillForgeState` with `activeConversation` | Remove `activeConversation` — chat state is managed internally by `useAgentChat`. Keep `skills`, `graphData`, `draftSkill`, `pendingPatterns`, `ingestionStatus` |
| Custom `{ type: "chunk" }` streaming | Streaming handled by Vercel AI SDK + `streamdown` renderer — no custom chunks |

**Key architectural insight:** The app now has **two communication channels** on one WebSocket:
1. **Chat channel** — `useAgentChat` ↔ `onChatMessage()` — fully managed by the framework (messages, streaming, tools, persistence)
2. **Ingestion channel** — raw `useAgent` ↔ `onMessage()` — our custom protocol for ingestion panel (ingest, confirm_patterns, patterns_extracted, etc.)

The custom message contract table shrinks to ingestion-only messages:

| Direction | Type | Payload | Description |
|-----------|------|---------|-------------|
| Client → Agent | `ingest` | `{ content: string }` | Paste/upload conversation text |
| Client → Agent | `confirm_patterns` | `{ patterns: Pattern[] }` | Confirm which patterns to proceed |
| Client → Agent | `approve` | `{ skillName: string }` | Approve final skill |
| Client → Agent | `delete_skill` | `{ skillName: string }` | Remove skill |
| Agent → Client | `ingestion_started` | `{ workflowId: string }` | Pipeline triggered |
| Agent → Client | `patterns_extracted` | `{ patterns: Pattern[] }` | Results ready for review |
| Agent → Client | `skill_drafted` | `{ markdown: string }` | Draft ready for review |
| Agent → Client | `error` | `{ message: string }` | Error |

Chat, refine, and search are now **tools** registered via `tool()` from the AI SDK, invoked naturally through conversation — not custom message types.

**§7 Tech Stack Table (lines 396-405)**

| Current | Updated |
|---------|---------|
| `Agent SDK (extends Durable Objects)` | `AIChatAgent` from `@cloudflare/ai-chat` (extends Agent SDK) |
| `Pages + useAgent React hook` | `Vite + @cloudflare/kumo + useAgentChat + useAgent` |
| No mention of Vercel AI SDK | Add row: `AI SDK — Vercel ai package — streamText() + tool() for LLM interaction` |
| No mention of build tool | Add row: `Build — Vite 7 + @cloudflare/vite-plugin` |

**§5 Visual Design (line ~95-115)**

Minor update: replace "custom dark CSS" references with "Tailwind v4 + @cloudflare/kumo components". The design intent (dark mode, developer-tool aesthetic) stays the same, but implementation uses kumo's `Surface`, `Button`, `Badge`, `InputArea` etc.

**§7 Sprint Timeline (lines 417-423)**

Day 1 description changes from "create SkillForgeAgent class with onMessage switch" to "extend AIChatAgent with onChatMessage + add Workflow binding + add SQLite schema + add ingestion panel alongside kumo chat".

---

### Document 2: `sprint-plan.md` — Day 1 tasks restructured

The overall 5-day structure holds. Day 1 task list changes:

| Old Task | New Task | Why |
|----------|----------|-----|
| 1.1 Project init | ~~Done~~ — already scaffolded | PROGRESS.md confirms |
| 1.2 wrangler.jsonc | **1.2 Add Workflow binding** to existing wrangler.jsonc | Only missing piece |
| 1.3 TypeScript types | **1.3 src/types.ts** — domain types only (remove Env, message contract types that are now framework-provided) | Env is auto-generated in `env.d.ts` |
| 1.4 Agent class from scratch | **1.4 Extend AIChatAgent**: override `onChatMessage` (chat + tools), add `onMessage` (ingestion), add `onStart` (SQL schema) | Build on starter, don't replace |
| 1.5 Workflow scaffold | **1.5 Same** — unchanged, Workflows are independent | — |
| 1.6 Prompts module | **1.6 Same** — prompt content unchanged | — |
| 1.7 React frontend from scratch | **1.7 Add Ingestion Panel**: keep existing kumo chat, add side panel for paste/upload with `useAgent` for ingestion state | Don't rewrite what works |
| 1.8 Smoke test | **1.8 Updated tests**: chat already works; verify model switch, SQL tables, Workflow compiles, ingestion panel renders | Tests shift to new features |

**New Day 1 exit criteria:**
- Chat works with `llama-3.3-70b-instruct-fp8-fast` (model switched from glm-4.7-flash)
- SQLite tables created on Agent start
- Workflow class compiles and is bound
- Ingestion panel renders alongside chat (even if non-functional)
- 5 prompt templates exist
- `npm run check` passes (oxfmt + oxlint + tsc)

---

### Document 3: `task1-initialization.md` — Needs full rewrite

This is the most impacted document. Every code snippet is wrong for the actual starter. Specific changes:

**Step 1.1 (Scaffold)** — Mark as DONE. Replace with "verify existing scaffold, inspect actual file structure".

**Step 1.2 (wrangler.jsonc)** — Don't replace the file. Only **add** the Workflow binding:

```jsonc
// ADD to existing wrangler.jsonc:
"workflows": [
  {
    "name": "ingestion-pipeline",
    "binding": "INGESTION_WORKFLOW",
    "class_name": "IngestionPipeline"
  }
]
```

Verify `ai` binding and `new_sqlite_classes` are already present.

**Step 1.3 (types.ts)** — Slimmer file. Remove `Env` (auto-generated), remove `ClientMessage`/`AgentMessage` union types (chat is framework-managed). Keep: `ExtractedPattern`, `CrossrefVerdict`, `SkillMetadata`, `GraphNode`, `GraphEdge`, `SkillForgeState` (minus `activeConversation`), and add `IngestionMessage` type for the custom channel.

**Step 1.4 (Agent)** — Completely different pattern:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "@cloudflare/workers-ai-provider";
import { streamText, tool } from "ai";

export class ChatAgent extends AIChatAgent<Env> {
  onStart() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS skills (...)`);
    // same schema as before
  }

  async onChatMessage(onFinish) {
    const ai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: ai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: SYSTEM_PROMPT,
      messages: this.messages,
      tools: {
        searchSkills: tool({ description: "...", parameters: z.object({...}), execute: ... }),
        // refine, listSkills etc. as tools
      },
      onFinish,
    });
    return result.toDataStreamResponse();
  }

  // Separate handler for ingestion messages (non-chat)
  async onMessage(connection, message) {
    const parsed = JSON.parse(message);
    switch (parsed.type) {
      case "ingest": ...
      case "confirm_patterns": ...
      case "approve": ...
    }
  }
}
```

**Step 1.5 (Workflow)** — Unchanged. The Workflow code is framework-independent.

**Step 1.6 (Prompts)** — Prompt **content** unchanged. But the way they're **called** changes: Workflow steps still use raw `env.AI.run()` (Workflows don't have Vercel AI SDK context), while Agent chat uses `streamText()`. Add a note about this split.

**Step 1.7 (Frontend)** — Don't rewrite the chat. Add the ingestion panel:

```tsx
// Keep existing useAgentChat for chat panel (already works)
// Add useAgent for ingestion state sync
const agent = useAgent({ agent: "skill-forge-agent", name: "default-user" });

// Ingestion panel: separate UI zone with paste textarea + upload button
// Sends custom messages: agent.send(JSON.stringify({ type: "ingest", content }))
// Receives: onMessage handles "patterns_extracted", "skill_drafted", etc.
```

**Step 1.8 (Smoke test)** — Updated checklist:

| # | Test | Expected |
|---|------|----------|
| 1 | `npm run dev` | Vite serves at localhost:5173 |
| 2 | Chat with "hello" | Response from llama-3.3-70b (not glm-4.7-flash) |
| 3 | Check SQLite | 4 tables exist (verify via Agent log or test query) |
| 4 | Ingestion panel | Renders alongside chat (paste area visible) |
| 5 | `npm run check` | No lint/type/format errors |
| 6 | Workflow compiles | No build errors for IngestionPipeline class |

---

## Recommended Execution Order

I'd suggest creating the updated files in this order:

1. **task1-initialization.md** — Full rewrite (highest impact, blocks Claude Code execution)
2. **sprint-plan.md** — Update Day 1 tasks + exit criteria
3. **prompt-skill-forge-v2.md** — Update §5, §6 Module E, §7 tech stack + timeline

Want me to produce the updated files now? I'd start with `task1-initialization.md` since that's the one you'll hand to Claude Code next.