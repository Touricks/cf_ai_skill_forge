# Skill Forge — Sprint Plan

> Execution playbook. Hand individual tasks to Claude Code.
> Reference: prompt-skill-forge-v2.md, prompt-llm-internals-v2.md, cloudflare-platform-guide.md

---

## Sprint Overview

| Day | Focus | Risk | Hours | Key Deliverable |
|-----|-------|------|-------|-----------------|
| 1 | Scaffold + Agent skeleton | Low | 4-5h | Chat round-trip working end-to-end |
| 2 | Ingestion pipeline + panel | **HIGH** | 9h | Paste/upload in dedicated panel → get skill draft |
| 3 | Refinement + Skill CRUD | Medium | 8h | Interactive edit → save → search |
| 4 | Graph visualization | Medium | 8h | D3.js graph rendering from live data |
| 5 | Polish + README | Low | 4-5h | Deployable, reviewable submission |

### Risk Map

```
         HIGH RISK          LOW RISK
         ┌──────────────────────────────┐
COMPLEX  │ Day 2: Ingestion    Day 4:  │
         │ (LLM chain + retry  Graph   │
         │  + JSON parsing)    (D3 viz)│
         ├──────────────────────────────┤
SIMPLE   │ Day 3: Refinement  Day 1:   │
         │ (interactive loop)  Scaffold │
         │                    Day 5:   │
         │                    Polish   │
         └──────────────────────────────┘
```

Day 2 is scheduled early because it's highest risk. If LLM integration has surprises, Days 3-4 have buffer to absorb.

---

## Day 1 — Scaffold + Agent Skeleton (4-5h)

| Task | Description | Est. |
|------|-------------|------|
| 1.1 | ~~Project init~~ — **DONE** (agents-starter already scaffolded with AIChatAgent, kumo, Vite) | — |
| 1.2 | Add Workflow binding to existing wrangler.jsonc + `npm run types` | 10min |
| 1.3 | Domain types only in `src/types.ts` (no Env, no chat message types — framework-managed) | 20min |
| 1.4 | Extend AIChatAgent: override `onChatMessage` (SYSTEM_PROMPT + `streamText` + domain tools), add `onMessage` (ingestion protocol), add `onStart` (SQL schema) | 1.5h |
| 1.5 | IngestionPipeline Workflow: scaffold with step stubs | 30min |
| 1.6 | Prompts module: system + 5 prompt templates (note: Workflow uses `env.AI.run()`, Agent uses `streamText()`) | 30min |
| 1.7 | Add IngestionPanel component alongside existing kumo chat (collapsible textarea + upload, uses `useAgent` for ingestion channel) | 1.5h |
| 1.8 | Smoke test: model switched, 3 SQLite tables, ingestion panel renders, `npm run check` passes | 30min |

**Exit:** Browser → type message → streaming LLM response via `streamText()`. Kumo chat UI shows "Skill Forge" header. Collapsible ingestion panel renders above chat. 3 SQLite tables exist (skills, conversations, links). Workflow compiles. `npm run check` passes.

---

## Day 2 — Ingestion Pipeline (8h)

| Task | Description | Est. |
|------|-------------|------|
| 2.1 | Chunking utility: split into ≤2500 token blocks | 1h |
| 2.2 | Workflow Step 1: chunk conversation (non-LLM) | 30min |
| 2.3 | Workflow Step 2: Prompt 1 (Extract) + JSON parse + validate | 2h |
| 2.4 | Workflow Step 3: Prompt 2 (Crossref) batch against SQL | 1.5h |
| 2.5 | Workflow Step 4: Prompt 3 (Draft) per confirmed pattern | 1.5h |
| 2.6 | Agent ↔ Workflow: trigger, receive results, update state (incl. ingestionStatus, ingestionStep) | 1h |
| 2.7 | Ingestion Panel UI: paste textarea, drag-drop file upload, "Start Analysis" button, progress bar, collapse/expand toggle | 1.5h |
| 2.8 | Ingestion Panel UI: pattern cards display (from pendingPatterns state), confirm/reject interaction | 1h |
| 2.9 | Error handling: JSON retry, step retry, empty extraction, error routing to Ingestion Panel | 30min |

**Exit:** Open ingestion panel → paste/upload conversation → progress bar shows pipeline steps → patterns extracted → confirm in ingestion panel → draft skill in right panel. Chat usable in parallel. Retry works on garbage.

---

## Day 3 — Refinement Loop + Skill CRUD (8h)

| Task | Description | Est. |
|------|-------------|------|
| 3.1 | Prompt 4 (Refine): streaming in Agent, feedback loop | 1.5h |
| 3.2 | Skill save: on approve, write to SQLite, link conversation | 1h |
| 3.3 | Skill CRUD: list, view, update, delete | 1.5h |
| 3.4 | Prompt 5 (Search): SQL pre-filter + LLM answer | 1.5h |
| 3.5 | Commands: /ingest, /search, /skills, /skill [name] | 1h |
| 3.6 | Chat persistence verification: confirm AIChatAgent restores messages on reconnect (framework-managed) | 30min |
| 3.7 | Frontend: skill preview, approve/reject, command hints | 1h |

**Exit:** Full loop: ingest → review → refine → approve → search finds it. Persists across sessions.

---

## Day 4 — Graph Visualization (8h)

| Task | Description | Est. |
|------|-------------|------|
| 4.1 | Graph data in Agent: recomputeGraphData() | 1h |
| 4.2 | D3.js force-directed graph: nodes + edges | 2.5h |
| 4.3 | Node styling: size by usage, color by tag | 1h |
| 4.4 | Interactions: click → detail, hover → tooltip | 1.5h |
| 4.5 | Right panel toggle: graph / skill detail / ingestion | 1h |
| 4.6 | Filter controls: tag, date, usage threshold | 1h |

**Exit:** Graph renders 5+ skills with meaningful edges. Click node → full skill. Filters work.

---

## Day 5 — Polish + README (4-5h)

| Task | Description | Est. |
|------|-------------|------|
| 5.1 | Error states: network, timeout, empty repo | 1h |
| 5.2 | Loading states: skeletons, streaming, progress | 30min |
| 5.3 | Empty states: onboarding, empty graph | 30min |
| 5.4 | File upload polish: multi-file batch upload, format auto-detection (.md/.json/.txt) | 30min |
| 5.5 | Visual polish: dark theme, typography, responsive | 1h |
| 5.6 | README: architecture decisions, setup, screenshots | 1h |
| 5.7 | Deploy + verify production | 30min |

**Exit:** Deployed URL works. README explains decisions. Reviewer groks codebase in 10 min.

---

## Dependency Chain

```
Day 1: init → config → types → [agent + workflow + prompts parallel] → frontend → smoke test
Day 2: chunker → step1 → step2 → step3 → step4 → agent↔workflow → ingestion panel UI → pattern cards → errors
Day 3: [refine + search parallel] → save → CRUD → [commands + history + UI parallel]
Day 4: graph data → D3 render → [styling + interactions parallel] → panel toggle → filters
Day 5: [errors + loading + empty parallel] → [upload + polish parallel] → README → deploy
```

---

## Assignment Checkbox Mapping

| Requirement | Where It's Met |
|-------------|---------------|
| LLM integration | Workers AI (Llama 3.3 70B) — Agent uses Vercel AI SDK `streamText()` for chat + tools; Workflow uses raw `env.AI.run()` for pipeline prompts |
| Workflow / coordination | `IngestionPipeline` Cloudflare Workflow — 4-step chain with auto-retry |
| User input (chat/voice) | `useAgentChat` (chat channel) + `useAgent` (ingestion channel) — dual-channel WebSocket via `AIChatAgent` |
| Memory / state | `AIChatAgent` manages chat history internally; Agent's embedded SQLite (`this.sql`) persists skills, conversations, and links |
