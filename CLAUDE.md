# CLAUDE.md

## Project Overview

Skill Forge — an AI-powered skill distillation and management tool built on Cloudflare's platform. Transforms fragmented AI conversation history (from Claude, ChatGPT, Gemini) into a structured, searchable, graph-visualized skill repository. Built as a Cloudflare hiring assignment demonstrating idiomatic use of Agents SDK, Workflows, Workers AI, and Pages.

## Tech Stack

- **Runtime**: Cloudflare Workers (Durable Objects via Agents SDK)
- **LLM**: Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (target), `@cf/zai-org/glm-4.7-flash` (starter default)
- **Agent Framework**: `@cloudflare/ai-chat` (`AIChatAgent` base class) + `agents` SDK
- **Workflow**: Cloudflare Workflows (`WorkflowEntrypoint`) for ingestion pipeline
- **Frontend**: React 19 + Vite 7 + `@cloudflare/kumo` UI components + Tailwind CSS v4
- **AI SDK**: Vercel AI SDK (`ai` package) for `streamText`, `tool`, message handling
- **Chat Hook**: `useAgentChat` from `@cloudflare/ai-chat/react` (NOT raw `useAgent`)
- **Streaming**: `streamdown` for markdown rendering during streaming
- **Storage**: Agent's embedded SQLite (`this.sql`) — no D1, no KV
- **Build**: Vite + `@cloudflare/vite-plugin` (NOT raw wrangler dev)
- **Types**: TypeScript 5.9, strict mode
- **Linting**: oxlint + oxfmt

## Directory Structure

```
cloudflareProject/              # Git root, docs live here
├── CLAUDE.md                   # This file (static config)
├── PROGRESS.md                 # Dynamic session log
├── requirement.md              # Assignment requirements
├── docs/
│   ├── prompt-skill-forge-v2.md        # Product design spec
│   ├── prompt-llm-internals-v2.md      # LLM prompt engineering guide
│   ├── sprint-plan.md                  # 5-day sprint plan
│   ├── task1-initialization.md         # Day 1 execution plan
│   ├── cloudflare-platform-guide.md    # Platform architecture reference
│   └── test/                           # Test plans per day
│       ├── test-strategy.md
│       ├── day1-scaffold.test-plan.md
│       ├── day2-ingestion.test-plan.md
│       ├── day3-refinement.test-plan.md
│       ├── day4-graph.test-plan.md
│       └── day5-polish.test-plan.md
└── agents-starter/             # Application code (from cloudflare/agents-starter)
    ├── src/
    │   ├── server.ts           # Agent + Worker entry (ChatAgent class)
    │   ├── app.tsx             # React app (Chat UI)
    │   ├── client.tsx          # React DOM mount
    │   └── styles.css          # Tailwind + kumo imports
    ├── wrangler.jsonc          # Cloudflare bindings config
    ├── vite.config.ts          # Build config
    ├── tsconfig.json           # TypeScript config
    ├── env.d.ts                # Generated Env types
    ├── index.html              # HTML entry
    └── package.json            # Dependencies
```

## Code Conventions

- **Naming**: kebab-case files, PascalCase classes, camelCase functions/variables
- **Types**: Strict TypeScript, explicit return types on public methods
- **Imports**: Use `type` imports for type-only imports (`import type { ... }`)
- **Formatting**: oxfmt (run `npm run format`)
- **Linting**: oxlint (run `npm run lint`)
- **Commit format**: `[module] action: description` (e.g., `[agent] feat: add ingestion pipeline trigger`)

## Build & Run

```bash
cd agents-starter
npm install
npm run dev          # Vite dev server at http://localhost:5173 (requires wrangler login)
npm run deploy       # Build + deploy to Cloudflare
npm run check        # Format check + lint + type check
npx wrangler login   # Authenticate with Cloudflare (required for remote AI binding)
```

## Hard Rules (Do NOT)

- Do not modify .env files or commit credentials
- Do not replace `AIChatAgent` with raw `Agent` — the starter uses `@cloudflare/ai-chat` and we build on top of it
- Do not replace `@cloudflare/kumo` UI components with raw HTML/CSS — maintain consistency with the design system
- Do not replace `useAgentChat` with raw `useAgent` for chat — the chat hook handles message persistence, streaming, and tool calls
- Do not use D1 or KV — all storage goes through Agent's embedded SQLite (`this.sql`)
- Do not add REST API endpoints for things that can go through WebSocket messages
- Do not install packages outside the project
- Do not touch production data or force-push to main

## Key Architecture Decisions

1. **AIChatAgent over raw Agent**: The starter template uses `AIChatAgent` from `@cloudflare/ai-chat` which provides built-in message persistence, streaming, and tool handling. We extend it rather than replacing it.

2. **Vercel AI SDK integration**: The starter uses `streamText()`, `tool()`, and `UIMessage` from the `ai` package. All LLM calls should go through this SDK, not raw `env.AI.run()` calls.

3. **Dual-panel UI with separate Ingestion Panel**: The ingestion (paste/upload conversations) is a separate UI zone from the chat panel. Both share one WebSocket connection but send different message types. See `docs/prompt-skill-forge-v2.md` Section 5.

4. **Cloudflare Workflows for ingestion pipeline**: Multi-step LLM chain (Extract → Crossref → Draft) runs in a Workflow for step isolation and automatic retry. Interactive features (Refine, Search) stay in the Agent.

5. **Embedded SQLite, not D1+KV**: Zero-latency reads colocated with compute. Each user gets their own Agent instance with isolated storage.

6. **Kumo + Tailwind v4**: The UI uses `@cloudflare/kumo` components with Tailwind CSS v4 (not v3). The `@import` syntax in styles.css is Tailwind v4 specific.
