# Task 1 — Day 1: Initialization (Claude Code Execution Plan)

> Hand this file to Claude Code. Prereq: Node >= 18, npm, Cloudflare account with Workers Paid ($5/mo).
> Reference: prompt-skill-forge-v2.md, prompt-llm-internals-v2.md, cloudflare-platform-guide.md

---

## Goal

Extend the existing `cloudflare/agents-starter` template into Skill Forge. By end of Day 1: chat works with the target LLM model, SQLite tables for skills/conversations exist, Workflow class compiles, and the ingestion panel renders alongside the existing kumo chat UI.

---

## Step 1.1 — Scaffold: DONE

The project was scaffolded from `cloudflare/agents-starter` (March 2026). The starter provides:

- **Agent**: `AIChatAgent<Env>` in `src/server.ts` with `onChatMessage` using Vercel AI SDK `streamText()`
- **Frontend**: React 19 + `@cloudflare/kumo` components + `useAgentChat` hook in `src/app.tsx`
- **Build**: Vite 7 + `@cloudflare/vite-plugin` (`npm run dev` serves at localhost:5173)
- **Config**: `wrangler.jsonc` with AI binding (`remote: true`), ChatAgent DO binding, SQLite migration
- **Dependencies**: `ai` (Vercel AI SDK), `@cloudflare/ai-chat`, `agents`, `workers-ai-provider`, `zod`, `streamdown`, `@cloudflare/kumo`, `@phosphor-icons/react`
- **Starter model**: `@cf/zai-org/glm-4.7-flash` (will be switched to target model)

**No action needed.** Proceed to Step 1.2.

---

## Step 1.2 — wrangler.jsonc: Add Workflow Binding (10min)

The starter's `wrangler.jsonc` already has:
- `"ai": { "binding": "AI", "remote": true }`
- `"durable_objects"` with `ChatAgent` binding
- `"migrations"` with `"new_sqlite_classes": ["ChatAgent"]`

**Only add** the Workflow binding:

```jsonc
// ADD to existing wrangler.jsonc (after "migrations"):
"workflows": [
  {
    "name": "ingestion-pipeline",
    "binding": "INGESTION_WORKFLOW",
    "class_name": "IngestionPipeline"
  }
]
```

Then regenerate types:

```bash
npm run types
```

This updates `env.d.ts` to include `INGESTION_WORKFLOW: Workflow`.

**Verify:** Open `env.d.ts` and confirm `AI`, `ChatAgent`, and `INGESTION_WORKFLOW` are all present.

---

## Step 1.3 — src/types.ts: Domain Types Only (20min)

Create `src/types.ts` with domain types. Do NOT include:
- ~~`Env`~~ — auto-generated in `env.d.ts` by `npm run types`
- ~~`ClientMessage`/`AgentMessage` unions for chat~~ — chat is managed by `useAgentChat`/`onChatMessage`
- ~~`ChatMessage`~~ — chat history is managed internally by `AIChatAgent`
- ~~`activeConversation`~~ — chat state is managed by the framework

```typescript
// ============================================================
// Domain models
// ============================================================
export interface ExtractedPattern {
  name: string;
  description: string;
  evidence: string[];
  completeness: "complete" | "partial" | "fragment";
  tags: string[];
}

export interface CrossrefVerdict {
  pattern_name: string;
  verdict: "new" | "update" | "duplicate";
  target_skill: string | null;
  reason: string;
  new_information: string | null;
}

export interface SkillMetadata {
  name: string;
  description: string;
  tags: string[];
  dependencies: string[];
  version: string;
  created: string;
  last_used: string;
  usage_count: number;
  source_conversations: string[];
  trigger_patterns: string[];
}

export interface GraphNode {
  id: string;
  tags: string[];
  size: number;
  color: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "dependency" | "shared_conversation";
  weight?: number;
}

// ============================================================
// Ingestion channel messages (custom WebSocket protocol)
// Chat messages are handled by useAgentChat/onChatMessage — not here
// ============================================================

// Client → Agent (via useAgent.send)
export type IngestionClientMessage =
  | { type: "ingest"; content: string }
  | { type: "confirm_patterns"; patterns: ExtractedPattern[] }
  | { type: "approve"; skillName: string }
  | { type: "delete_skill"; skillName: string };

// Agent → Client (via connection.send / this.broadcast)
export type IngestionAgentMessage =
  | { type: "ingestion_started"; workflowId: string }
  | { type: "patterns_extracted"; patterns: ExtractedPattern[] }
  | { type: "skill_drafted"; markdown: string }
  | { type: "error"; message: string };

// ============================================================
// Agent state (synced to frontend via useAgent setState)
// Note: chat state (messages, streaming) is managed by
// useAgentChat internally — not in this state object
// ============================================================
export interface SkillForgeState {
  skills: SkillMetadata[];
  graphData: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  draftSkill: string | null;
  pendingPatterns: ExtractedPattern[];
  ingestionStatus: "idle" | "running" | "complete" | "error";
}
```

---

## Step 1.4 — Extend AIChatAgent in src/server.ts (1.5h)

The starter's `ChatAgent` already extends `AIChatAgent<Env>` with a working `onChatMessage`. We modify it — not replace it.

**Changes to make:**

1. **Switch model** from `@cf/zai-org/glm-4.7-flash` to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
2. **Replace system prompt** with Skill Forge's `SYSTEM_PROMPT`
3. **Replace demo tools** (getWeather, getUserTimezone, calculate, schedule) with domain tools (`searchSkills`, `refineSkill`, `listSkills`)
4. **Add `onStart`** to create SQLite tables
5. **Add `onMessage`** handler for the ingestion protocol (separate from chat)
6. **Remove** MCP server support and schedule support (not needed for Skill Forge)

```typescript
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
} from "ai";
import { z } from "zod";
import type { Connection } from "agents";
import { SYSTEM_PROMPT } from "./prompts";
import type {
  IngestionClientMessage,
  IngestionAgentMessage,
  SkillMetadata,
  GraphNode,
  GraphEdge,
} from "./types";

export class ChatAgent extends AIChatAgent<Env> {
  // ── Lifecycle ─────────────────────────────────────────
  onStart(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        dependencies TEXT NOT NULL DEFAULT '[]',
        version TEXT NOT NULL DEFAULT '1.0.0',
        created TEXT NOT NULL,
        last_used TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        source_conversations TEXT NOT NULL DEFAULT '[]',
        trigger_patterns TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        ingested_at TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        extracted_patterns TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_skill_links (
        conversation_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        PRIMARY KEY (conversation_id, skill_name)
      );
    `);
  }

  // ── Chat (managed by AIChatAgent framework) ──────────
  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
      }),
      tools: {
        searchSkills: tool({
          description:
            "Search the user's skill repository by query. Use when the user asks about their skills or wants to find a skill.",
          inputSchema: z.object({
            query: z.string().describe("Search query"),
          }),
          execute: async ({ query }) => {
            const rows = this.sql
              .exec(
                `SELECT name, description, tags FROM skills
                 WHERE name LIKE ? OR description LIKE ? OR tags LIKE ?`,
                `%${query}%`,
                `%${query}%`,
                `%${query}%`
              )
              .toArray();
            return rows.length > 0
              ? rows
              : "No matching skills found.";
          },
        }),

        listSkills: tool({
          description:
            "List all skills in the user's repository with their metadata.",
          inputSchema: z.object({}),
          execute: async () => {
            const rows = this.sql
              .exec(
                "SELECT name, description, tags, usage_count FROM skills ORDER BY last_used DESC"
              )
              .toArray();
            return rows.length > 0
              ? rows
              : "No skills in repository yet. Ingest some conversations to get started.";
          },
        }),

        refineSkill: tool({
          description:
            "Refine an existing skill based on user feedback. Use when the user wants to edit or improve a skill.",
          inputSchema: z.object({
            skillName: z.string().describe("Name of the skill to refine"),
            feedback: z.string().describe("User's feedback for refinement"),
          }),
          execute: async ({ skillName, feedback }) => {
            const rows = this.sql
              .exec("SELECT content FROM skills WHERE name = ?", skillName)
              .toArray();
            if (rows.length === 0) {
              return `Skill "${skillName}" not found.`;
            }
            return {
              currentContent: (rows[0] as any).content,
              feedback,
              instruction:
                "Use the REFINE_PROMPT pattern to refine this skill based on the feedback.",
            };
          },
        }),
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Ingestion channel (custom WebSocket messages) ────
  async onMessage(connection: Connection, message: string): Promise<void> {
    let parsed: IngestionClientMessage;
    try {
      parsed = JSON.parse(message) as IngestionClientMessage;
    } catch {
      this.sendIngestion(connection, {
        type: "error",
        message: "Invalid JSON",
      });
      return;
    }

    switch (parsed.type) {
      case "ingest":
        return this.handleIngest(connection, parsed.content);
      case "confirm_patterns":
      case "approve":
      case "delete_skill":
        this.sendIngestion(connection, {
          type: "error",
          message: `${parsed.type} not implemented yet. Coming Day 2-3.`,
        });
        return;
      default:
        // Unknown message type — ignore (may be framework message)
        break;
    }
  }

  // ── Day 2 stub ─────────────────────────────────────────
  private async handleIngest(
    connection: Connection,
    content: string
  ): Promise<void> {
    this.sendIngestion(connection, {
      type: "error",
      message: "Ingestion pipeline not implemented yet. Coming Day 2.",
    });
  }

  // ── Helpers ─────────────────────────────────────────────
  private sendIngestion(
    connection: Connection,
    message: IngestionAgentMessage
  ): void {
    connection.send(JSON.stringify(message));
  }

  private loadSkillMetadata(): SkillMetadata[] {
    const rows = this.sql
      .exec(
        `SELECT name, description, tags, dependencies, version,
                created, last_used, usage_count,
                source_conversations, trigger_patterns
         FROM skills`
      )
      .toArray();

    return rows.map((r: any) => ({
      name: r.name,
      description: r.description,
      tags: JSON.parse(r.tags),
      dependencies: JSON.parse(r.dependencies),
      version: r.version,
      created: r.created,
      last_used: r.last_used,
      usage_count: r.usage_count,
      source_conversations: JSON.parse(r.source_conversations),
      trigger_patterns: JSON.parse(r.trigger_patterns),
    }));
  }

  private computeGraphData(
    skills: SkillMetadata[]
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (!skills.length) return { nodes: [], edges: [] };

    const TAG_COLORS: Record<string, string> = {
      architecture: "#f97316",
      frontend: "#3b82f6",
      backend: "#10b981",
      devops: "#8b5cf6",
      testing: "#ec4899",
      documentation: "#eab308",
      default: "#6b7280",
    };

    const nodes: GraphNode[] = skills.map((s) => ({
      id: s.name,
      tags: s.tags,
      size: Math.max(12, Math.log(s.usage_count + 1) * 12),
      color: TAG_COLORS[s.tags[0]?.toLowerCase()] || TAG_COLORS.default,
    }));

    const edges: GraphEdge[] = [];

    for (const skill of skills) {
      for (const dep of skill.dependencies) {
        if (skills.some((s) => s.name === dep)) {
          edges.push({ source: skill.name, target: dep, type: "dependency" });
        }
      }
    }

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
}

// Workflow export (see Step 1.5)
export { IngestionPipeline } from "./workflow";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

### Key differences from the old plan

| Aspect | Old Plan | New Reality |
|--------|----------|-------------|
| Base class | `Agent<Env, State>` | `AIChatAgent<Env>` (extends Agent) |
| Chat handling | Manual `onMessage` switch + `env.AI.run()` + SSE parsing | `onChatMessage` + `streamText()` + `tool()` |
| Chat persistence | Manual `chat_history` table + `appendChat()` | Handled internally by `AIChatAgent` |
| Streaming | Manual `chunk`/`done` messages | Vercel AI SDK `toUIMessageStreamResponse()` |
| Tools (search, refine) | Custom message types | `tool()` definitions in `streamText()` |
| Ingestion messages | Mixed with chat in `onMessage` | Separate `onMessage` handler (chat goes through `onChatMessage`) |
| Tables | 4 (skills, conversations, links, chat_history) | 3 (skills, conversations, links) — chat_history is framework-managed |

### Adaptation Notes for Claude Code

**`onMessage` vs `onChatMessage`:** The `AIChatAgent` framework routes chat protocol messages to `onChatMessage` automatically. Custom WebSocket messages (our ingestion protocol) go to `onMessage`. These are two separate handlers — both are active simultaneously.

**SQL API:** The Agent's `this.sql.exec()` works as shown. Pass parameters after the SQL string as positional arguments.

**Streaming:** `streamText()` from Vercel AI SDK handles all streaming. The return value `result.toUIMessageStreamResponse()` is consumed by `useAgentChat` on the frontend. No manual SSE parsing needed.

**Tools:** `tool()` from the `ai` package registers server-side tools. The framework handles tool call rendering, approval UX, and execution — no custom message types needed.

---

## Step 1.5 — src/workflow.ts — Ingestion Scaffold (30min)

```typescript
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { ExtractedPattern, CrossrefVerdict } from "./types";

export class IngestionPipeline extends WorkflowEntrypoint<Env> {
  async run(
    event: WorkflowEvent<{ conversationText: string; agentId: string }>,
    step: WorkflowStep
  ) {
    const { conversationText, agentId } = event.payload;

    // Step 1: Chunk conversation (non-LLM)
    const chunks = await step.do("chunk-conversation", async () => {
      return this.chunkConversation(conversationText);
    });

    // Step 2: Extract patterns — Prompt 1 (stub for Day 2)
    const patterns = await step.do(
      "extract-patterns",
      { retries: { limit: 2, backoff: "exponential" } },
      async () => {
        // TODO Day 2: this.env.AI.run() call with EXTRACT_PROMPT
        // Note: Workflows use env.AI.run() directly, NOT streamText()
        return [] as ExtractedPattern[];
      }
    );

    // Step 3: Crossref existing skills — Prompt 2 (stub for Day 2)
    const verdicts = await step.do(
      "crossref-skills",
      { retries: { limit: 2, backoff: "exponential" } },
      async () => {
        // TODO Day 2: this.env.AI.run() call with CROSSREF_PROMPT
        return [] as CrossrefVerdict[];
      }
    );

    // Step 4: Draft skills — Prompt 3 (stub for Day 2)
    const drafts = await step.do(
      "draft-skills",
      { retries: { limit: 2, backoff: "exponential" } },
      async () => {
        // TODO Day 2: this.env.AI.run() call with DRAFT_PROMPT
        return [] as string[];
      }
    );

    return { chunks: chunks.length, patterns, verdicts, drafts };
  }

  private chunkConversation(text: string): string[] {
    const turns = text
      .split(/(?=(?:User|Human|Assistant|AI|Claude):)/i)
      .filter(Boolean);
    const chunks: string[] = [];
    let currentChunk = "";

    for (const turn of turns) {
      const estimatedTokens =
        (currentChunk + turn).split(/\s+/).length * 1.3;
      if (estimatedTokens > 2500 && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = turn;
      } else {
        currentChunk += turn;
      }
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }
}
```

**LLM call split:** Workflow steps use `this.env.AI.run()` (raw Workers AI) because Workflows don't have access to the Vercel AI SDK context. The Agent's `onChatMessage` uses `streamText()` for interactive chat. This is the correct architectural split — batch pipeline vs interactive chat.

---

## Step 1.6 — src/prompts.ts (30min)

Prompt template content is unchanged from the original plan. Create `src/prompts.ts` with:
- `SYSTEM_PROMPT` — Skill Forge personality
- `EXTRACT_PROMPT` — Pattern extraction (Workflow Step 2, called via `env.AI.run()`)
- `CROSSREF_PROMPT` — Cross-referencing (Workflow Step 3, called via `env.AI.run()`)
- `DRAFT_PROMPT` — Skill drafting (Workflow Step 4, called via `env.AI.run()`)
- `REFINE_PROMPT` — Interactive refinement (Agent `tool()`, called via `streamText()`)
- `SEARCH_PROMPT` — Search answering (Agent `tool()`, called via `streamText()`)
- `fillTemplate()` — Template variable substitution

**Note on where prompts are called:**

| Prompt | Used In | Called Via |
|--------|---------|-----------|
| `SYSTEM_PROMPT` | Agent `onChatMessage` | `streamText({ system: SYSTEM_PROMPT })` |
| `EXTRACT_PROMPT` | Workflow Step 2 | `this.env.AI.run(model, { messages })` |
| `CROSSREF_PROMPT` | Workflow Step 3 | `this.env.AI.run(model, { messages })` |
| `DRAFT_PROMPT` | Workflow Step 4 | `this.env.AI.run(model, { messages })` |
| `REFINE_PROMPT` | Agent `refineSkill` tool | Within `tool()` execute function |
| `SEARCH_PROMPT` | Agent `searchSkills` tool | Within `tool()` execute function |

See the original prompt content in `docs/prompt-llm-internals-v2.md` — the template text is unchanged. Only the calling mechanism differs between Agent (Vercel AI SDK `streamText`) and Workflow (raw `env.AI.run`).

---

## Step 1.7 — Frontend: Add Ingestion Panel (1.5h)

The starter's `src/app.tsx` already provides a fully working chat UI with:
- `useAgentChat` from `@cloudflare/ai-chat/react` for chat messages, streaming, tool calls
- `useAgent` from `agents/react` for WebSocket connection management
- kumo components (`Button`, `Badge`, `InputArea`, `Empty`, `Surface`, `Text`, `Switch`)
- `Streamdown` for markdown rendering during streaming
- Theme toggle (dark/light), debug mode toggle, MCP panel

**Changes to make:**

1. **Header**: Change `"Agent Starter"` to `"Skill Forge"`, badge from `"AI Chat"` to `"Skills"`
2. **Empty state prompts**: Replace weather/timezone/calculate with skill-related prompts:
   - "What skills do I have?"
   - "Search for React patterns"
   - "Help me refine a skill"
   - "Show my skill repository"
3. **Default dark mode**: Set initial `data-mode="dark"` on `<html>`
4. **Add `IngestionPanel` component**: Collapsible panel above the chat messages area

**Ingestion Panel pattern:**

```tsx
// The existing useAgent hook already exists in the starter's Chat component.
// Use it for ingestion messages (custom protocol).
// useAgentChat handles chat messages — completely separate channel.

function IngestionPanel({ agent }: { agent: ReturnType<typeof useAgent> }) {
  const [content, setContent] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const handleIngest = () => {
    if (!content.trim()) return;
    agent.send(JSON.stringify({ type: "ingest", content: content.trim() }));
    setContent("");
  };

  if (!isOpen) {
    return (
      <div className="px-5 pt-4">
        <Button variant="outline" size="sm" onClick={() => setIsOpen(true)}>
          + Ingest Conversation
        </Button>
      </div>
    );
  }

  return (
    <div className="px-5 pt-4">
      <Surface className="p-4 rounded-xl ring ring-kumo-line">
        <div className="flex items-center justify-between mb-3">
          <Text size="sm" bold>Ingest Conversation</Text>
          <Button variant="ghost" size="sm" shape="square" onClick={() => setIsOpen(false)}>
            <XIcon size={14} />
          </Button>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste an AI conversation here..."
          rows={6}
          className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive font-mono resize-y"
        />
        <div className="flex gap-2 mt-2">
          <Button variant="primary" size="sm" onClick={handleIngest} disabled={!content.trim()}>
            Start Analysis
          </Button>
        </div>
      </Surface>
    </div>
  );
}
```

**Dual-channel architecture:**

```
useAgentChat ──→ onChatMessage()    # Chat: messages, streaming, tools
useAgent     ──→ onMessage()        # Ingestion: ingest, confirm, approve
```

Both hooks share one WebSocket connection to the same `ChatAgent` instance. The `AIChatAgent` framework dispatches chat protocol messages to `onChatMessage` and all other messages to `onMessage`.

**Do NOT:**
- Replace the existing kumo chat UI
- Replace `useAgentChat` with raw `useAgent` for chat
- Add custom `chunk`/`done` message handling (streaming is handled by the framework)

---

## Step 1.8 — Smoke Test (30min)

```bash
cd agents-starter
npm run dev
# Opens at http://localhost:5173
```

### Test Checklist

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | `npm run dev` starts | Vite serves at localhost:5173, no build errors |
| 2 | Page loads | Chat UI with "Skill Forge" header, dark mode |
| 3 | Chat "hello" | Streaming response from `llama-3.3-70b-instruct-fp8-fast` (not glm-4.7-flash) |
| 4 | Check devtools console | No errors, WebSocket connected |
| 5 | Check SQLite tables | Log or query confirms `skills`, `conversations`, `conversation_skill_links` tables exist |
| 6 | Ingestion panel renders | Collapsible "Ingest Conversation" button visible |
| 7 | Click "Ingest Conversation" | Textarea + "Start Analysis" button appear |
| 8 | Paste text, click "Start Analysis" | "not implemented yet" error (expected Day 2 stub) |
| 9 | Workflow compiles | No build errors related to `IngestionPipeline` |
| 10 | `npm run check` passes | oxfmt + oxlint + tsc all pass |

### Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `AI binding not found` | Missing ai config | Already in wrangler.jsonc — verify `"ai": { "binding": "AI" }` |
| `WorkflowEntrypoint not found` | Wrong import path | Use `cloudflare:workers` import |
| `IngestionPipeline` not bound | Missing workflows config | Add `"workflows"` array to wrangler.jsonc |
| Workers AI 403 | Account not activated | Dashboard → Workers AI → activate |
| Workers AI rate limit | Free tier exceeded | Upgrade to Paid ($5/mo) or wait UTC midnight |
| `this.sql is not a function` | Missing migration | Already has `new_sqlite_classes` — verify in wrangler.jsonc |

---

## Day 1 Definition of Done

- [ ] `npm run dev` starts without errors (Vite + wrangler)
- [ ] Model switched to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- [ ] 3 SQLite tables created on Agent start (skills, conversations, conversation_skill_links)
- [ ] Chat round-trip: user → AIChatAgent → `streamText()` → Workers AI → streaming → user
- [ ] Domain tools registered: `searchSkills`, `listSkills`, `refineSkill`
- [ ] Workflow class (`IngestionPipeline`) compiles and is bound
- [ ] 6 prompt templates exist as typed constants in `src/prompts.ts`
- [ ] Ingestion panel renders alongside kumo chat UI
- [ ] `npm run check` passes (oxfmt + oxlint + tsc)

**→ Ready for Day 2: Ingestion Pipeline**
