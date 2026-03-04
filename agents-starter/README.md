# Skill Forge

An AI-powered skill distillation tool that transforms fragmented AI conversation history into a structured, searchable, graph-visualized skill repository — built entirely on Cloudflare's platform.

## What It Does

1. **Ingest** — Paste or upload conversation logs from Claude, ChatGPT, or Gemini
2. **Synthesize** — A multi-step Workflow extracts patterns, cross-references existing skills, and drafts a structured SKILL.md
3. **Refine** — Chat with the agent to iterate on skill descriptions, tags, and trigger patterns
4. **Visualize** — Browse your skill graph with D3 force-directed layout, filter by tag, and inspect dependencies

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  React + Vite + @cloudflare/kumo                    │
│  ┌──────────────┐  ┌────────────────────────────┐   │
│  │ Ingestion    │  │ Chat Panel                 │   │
│  │ Panel        │  │ (Streamdown + tool cards)  │   │
│  └──────┬───────┘  └────────────┬───────────────┘   │
│         │ WebSocket             │ WebSocket          │
└─────────┼───────────────────────┼───────────────────┘
          │                       │
┌─────────┴───────────────────────┴───────────────────┐
│  AIChatAgent (Durable Object)                       │
│  ┌────────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ onMessage  │  │ onChat   │  │ Embedded SQLite │  │
│  │ (ingest)   │  │ (tools)  │  │ (skills, convos)│  │
│  └─────┬──────┘  └────┬─────┘  └─────────────────┘  │
│        │              │                              │
│        ▼              ▼                              │
│  Workflow API    Anthropic SDK                       │
│  (create)        (streamText)                        │
└────────┬────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────┐
│  IngestionPipeline (Workflow)                        │
│  Step 1: Extract patterns   ──► Workers AI (Llama)  │
│  Step 2: Cross-ref skills   ──► Workers AI (Llama)  │
│  Step 3: Draft SKILL.md     ──► Workers AI (Llama)  │
│  Step 4: Notify agent       ──► Agent RPC callback  │
└─────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite 7 + Tailwind v4 + `@cloudflare/kumo` |
| Agent | `AIChatAgent` from `@cloudflare/ai-chat` (Durable Object) |
| Chat LLM | Anthropic Claude via `@ai-sdk/anthropic` + Vercel AI SDK `streamText()` |
| Workflow LLM | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Workflow | Cloudflare Workflows (`WorkflowEntrypoint`) |
| Storage | Agent embedded SQLite (`this.sql`) |
| Graph | D3.js force-directed visualization |
| Streaming | `streamdown` for markdown rendering |

## Architecture Decisions

### 1. AIChatAgent + Workflows (not just one)

The Agent handles interactive chat (streaming responses, tool calls, state sync) while the Workflow handles the multi-step ingestion pipeline. This separation matters because ingestion involves 3 sequential LLM calls that benefit from Workflow's automatic step retry and isolation — if step 2 fails, step 1 doesn't re-run. The Agent stays responsive to chat while ingestion runs in the background.

### 2. Embedded SQLite (not D1 + KV)

Each user gets their own Agent instance with colocated SQLite storage. This means zero-latency reads (no network hop to D1), per-user data isolation by default, and simpler code — `this.sql` instead of managing separate D1 bindings and KV namespaces. The trade-off is no cross-user querying, which we don't need.

### 3. Separate Ingestion Panel from Chat

Conversation ingestion (paste/upload) is a different interaction pattern from chat. It's a one-shot action with progress feedback, not a back-and-forth conversation. Keeping it as a dedicated UI zone above the chat avoids polluting the chat history with ingestion artifacts and lets the user see progress while still chatting.

### 4. Anthropic for Chat, Workers AI for Workflow

Chat requires high-quality tool use and streaming — Anthropic Claude excels at both. The ingestion Workflow runs structured extraction prompts where Llama 3.3 70B performs well and runs natively on Cloudflare's infrastructure with no external API dependency or latency. This dual-LLM approach optimizes for both quality and cost.

## Setup

```bash
# Clone and install
cd agents-starter
npm install

# Authenticate with Cloudflare (required for Workers AI binding)
npx wrangler login

# Set local secrets
# Create .dev.vars file with:
# ANTHROPIC_API_KEY=your-key-here
# MODEL=claude-sonnet-4-20250514

# Start development server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Deploy

```bash
# Set production secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MODEL

# Build and deploy
npm run deploy
```

## Project Structure

```
src/
  server.ts              # AIChatAgent: chat, tools, ingestion, state management
  workflow.ts            # IngestionPipeline: extract → crossref → draft → notify
  workflow-helpers.ts    # Shared utilities for workflow steps
  prompts.ts             # LLM prompt templates (extract, crossref, draft, refine, search)
  types.ts               # Domain types (SkillForgeState, SkillMetadata, messages)
  graph.ts               # computeGraphData() — builds nodes/edges from skills
  app.tsx                # Two-panel layout: Ingestion+Chat | Graph+Preview
  client.tsx             # React DOM mount
  styles.css             # Tailwind v4 + kumo imports
  components/
    IngestionPanel.tsx   # Paste/upload conversations + progress display
    GraphView.tsx        # D3 force-directed skill graph with zoom/drag/filter
    SkillPreview.tsx     # Skill detail view (tags, metadata, dependencies)
    ToolPartView.tsx     # Tool call/result rendering in chat
    ThemeToggle.tsx      # Dark/light mode toggle
```

## Assignment Requirements

| Requirement | Implementation |
|-------------|---------------|
| LLM | Anthropic Claude (chat via `@ai-sdk/anthropic`), Workers AI Llama 3.3 70B (ingestion pipeline) |
| Workflow / Coordination | Cloudflare Workflows (`IngestionPipeline`) with 4-step LLM chain + AIChatAgent Durable Object |
| User Input via Chat | WebSocket chat with streaming responses, tool calls (`list_skills`, `search_skills`, `refine_skill`, `get_skill`), and conversation ingestion panel |
| Memory or State | Embedded SQLite for persistent skill storage + Agent `setState()` for real-time graph sync |

## License

MIT
