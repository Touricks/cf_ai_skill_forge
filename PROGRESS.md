# PROGRESS.md

> Dynamic log of what we've done, what went wrong, and what we learned.
> This file is the project's running memory. **Append only — never overwrite.**

---

## 2026-03-03

### Completed: Documentation suite and project scaffold

**Docs created:**
- Translated and analyzed `prompt-skill-forge-v2.md` (product architecture spec)
- Updated design docs with **separate Ingestion Panel** — UI zone independent from chat for submitting AI conversations. Updated `prompt-skill-forge-v2.md` (Section 5 layout, Section 6 Module E message contract + state), `prompt-llm-internals-v2.md` (architecture flow diagram), `sprint-plan.md` (Day 1-2 task adjustments)
- Created full test plan suite in `docs/test/` (6 files: strategy + days 1-5, with gate criteria and dependency map)

**Project scaffold:**
- `git init` + remote added: `https://github.com/Touricks/cf_ai_skillsdk.git`
- Scaffolded from `cloudflare/agents-starter` template into `agents-starter/`
- `npm install` completed (396 packages)
- `npx wrangler login` — authenticated with Cloudflare
- `npm run dev` — Vite dev server running at http://localhost:5173

### Pitfalls
- `npx create-cloudflare@latest` fails with `ERR_TTY_INIT_FAILED` in non-interactive shell — but files are cloned successfully before the error. Safe to ignore.
- `npm run dev` requires Cloudflare login because `wrangler.jsonc` has `"ai": { "binding": "AI", "remote": true }`. Must run `npx wrangler login` first.

### Lessons — Starter Template Diverges from Design Docs

The actual `cloudflare/agents-starter` (2026-03 version) is significantly more advanced than what our Day 1 design doc (`task1-initialization.md`) assumed. Critical differences:

| Aspect | Design Doc Assumed | Actual Starter |
|--------|-------------------|----------------|
| Agent base class | `Agent<Env, State>` from `agents` | `AIChatAgent<Env>` from `@cloudflare/ai-chat` |
| Chat handling | Manual `onMessage` + raw `env.AI.run()` streaming | `onChatMessage()` + Vercel AI SDK `streamText()` |
| Frontend chat | Raw `useAgent` hook + custom message protocol | `useAgentChat` hook with built-in persistence/streaming/tools |
| UI components | Raw React + custom dark CSS | `@cloudflare/kumo` design system + Tailwind v4 |
| Build tool | `wrangler dev` | Vite 7 + `@cloudflare/vite-plugin` |
| Default model | `llama-3.3-70b-instruct-fp8-fast` | `glm-4.7-flash` |
| Message format | Custom `{ type, content }` JSON | Vercel AI SDK `UIMessage` with parts |
| Tool system | None (manual) | `tool()` from `ai` package with approval flow |
| State sync | `this.setState()` → `useAgent` `onStateUpdate` | `useAgentChat` manages message state internally |

**Key decision**: We MUST adapt our design to build on top of `AIChatAgent` + `@cloudflare/kumo` + Vercel AI SDK, not replace them. The `task1-initialization.md` code snippets are outdated for this starter version.

**Specific adaptations needed:**
1. Extend `AIChatAgent` instead of raw `Agent` — override `onChatMessage` for chat, add separate `onMessage` handler for ingestion
2. Use `streamText()` + `tool()` from `ai` package — not raw `env.AI.run()` with manual SSE parsing
3. Use `@cloudflare/kumo` components (Button, Badge, Surface, InputArea, etc.) — not custom HTML
4. Keep `useAgentChat` for chat — add separate state management for ingestion panel
5. Change model from `glm-4.7-flash` to `llama-3.3-70b-instruct-fp8-fast`
6. The Workflow still needs to be added (`IngestionPipeline` class + wrangler.jsonc binding)

### Next Steps
- Adapt Day 1 implementation plan to work with `AIChatAgent` + `@cloudflare/kumo` stack
- Add Workflow binding to `wrangler.jsonc`
- Create `src/types.ts` with domain types (keep message contract types compatible with Vercel AI SDK)
- Add SQLite schema initialization in Agent's `onStart()`
- Add Ingestion Panel UI component alongside existing chat
- Switch model to `llama-3.3-70b-instruct-fp8-fast`
- Create initial commit and push to remote
