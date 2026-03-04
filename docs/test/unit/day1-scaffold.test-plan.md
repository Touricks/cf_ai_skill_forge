# Day 1 Test Plan — Scaffold + Agent Skeleton

> Covers tasks 1.1–1.8 from sprint-plan.md
> Dependencies: None (Day 1 is the foundation)

---

## Unit Tests

### U1.1 — TypeScript compilation (Task 1.3)

```
TEST: All source files compile without errors
RUN:  npx tsc --noEmit
PASS: Exit code 0, no type errors
```

### U1.2 — Prompt template fill (Task 1.6)

```
TEST: fillTemplate() replaces all placeholders
INPUT: fillTemplate("Hello {name}, you have {count} skills", { name: "Alice", count: "5" })
PASS: Returns "Hello Alice, you have 5 skills"

TEST: fillTemplate() handles missing vars gracefully
INPUT: fillTemplate("Hello {name}", {})
PASS: Returns "Hello {name}" (unreplaced placeholder stays)

TEST: fillTemplate() replaces multiple occurrences
INPUT: fillTemplate("{x} and {x}", { x: "ok" })
PASS: Returns "ok and ok"
```

### U1.3 — Prompt constants exist (Task 1.6)

```
TEST: All 6 prompt exports are non-empty strings
CHECK: SYSTEM_PROMPT, SYNTHESIZE_PROMPT, CROSSREF_PROMPT, DRAFT_PROMPT, REFINE_PROMPT, SEARCH_PROMPT
PASS: Each is typeof "string" && length > 50
```

### U1.4 — Type exports (Task 1.3)

```
TEST: All type interfaces are importable
CHECK: ConversationTurn, SynthesizedSkill, CrossrefVerdict, SkillMetadata, GraphNode, GraphEdge,
       IngestionClientMessage, IngestionAgentMessage, SkillForgeState
       (Note: ExtractedPattern still defined but unused after ingestion redesign)
PASS: No import errors
```

---

## Integration Tests

### I1.1 — Agent SQL schema initialization (Task 1.4)

```
TEST: onStart creates 3 tables
SETUP: Instantiate ChatAgent with miniflare SQLite
RUN:   agent.onStart()
CHECK: SELECT name FROM sqlite_master WHERE type='table'
PASS:  Result includes: skills, conversations, conversation_skill_links
```

### I1.2 — Agent onMessage routing for ingestion channel (Task 1.4)

```
TEST: "ingest" type routes to ingestion handler
SETUP: Mock connection, mock Workflow binding
RUN:   agent.onMessage(conn, '{"type":"ingest","turns":["User: help me\\nAssistant: sure"],"skillHint":"debugging"}')
PASS:  conn._parsed()[0].type === "ingestion_started" OR "error" with "not implemented"

TEST: Unknown type returns error
RUN:   agent.onMessage(conn, '{"type":"bogus"}')
PASS:  conn._parsed()[0].type === "error"

TEST: Invalid JSON returns error
RUN:   agent.onMessage(conn, 'not json')
PASS:  conn._parsed()[0].type === "error" && message includes "Invalid JSON"

Note: Chat messages are handled by onChatMessage (via useAgentChat / streamText),
not by onMessage. Chat routing is tested via streamText mock separately.
```

### I1.3 — Agent stub handlers (Task 1.4)

```
TEST: "ingest" returns "not implemented" stub
RUN:   agent.onMessage(conn, '{"type":"ingest","turns":["test"]}')
PASS:  conn._parsed()[0].type === "error" && message includes "not implemented"

TEST: "approve", "delete_skill" all return stubs
PASS:  Each returns error with "not implemented"

Note: "refine" and "search" are tool() calls invoked via onChatMessage, not
ingestion message types. They are tested via streamText tool invocation mocks.
```

### I1.4 — Health endpoint (Task 1.4) — Optional

```
TEST: GET /api/health returns JSON
NOTE: AIChatAgent does not have onRequest. This endpoint would need to be
      added to the Worker fetch handler, not the Agent class.
RUN:   fetch("http://localhost:5173/api/health")
PASS:  Response status 200, body is { status: "ok", skills: 0 }
      (Optional — not a core Agent feature, may be omitted)
```

### I1.5 — Chat persistence (Task 1.4)

```
TEST: Chat messages persist across Agent re-instantiation
NOTE: Chat persistence is managed internally by AIChatAgent (this.messages).
      There is no separate chat_history table — the framework handles storage.
SETUP: Agent with SQLite
RUN:   Send chat message via onChatMessage → verify this.messages includes it
       → simulate Agent restart → verify this.messages still returns prior messages
PASS:  Messages restored by the framework after restart (implicit persistence)
```

### I1.6 — State initialization (Task 1.4)

```
TEST: Initial state has correct shape
RUN:   agent.onStart()
CHECK: agent.state
PASS:  state.skills === [], state.graphData.nodes === [], state.graphData.edges === [],
       state.draftSkill === null, state.synthesizedSkill === null,
       state.ingestionStatus === "idle"
```

### I1.7 — Workflow compiles (Task 1.5)

```
TEST: IngestionPipeline class instantiates without errors
PASS:  No throw on import, class has run() method
```

---

## Smoke Tests (Manual — Browser)

### S1.1 — Dev server starts (Task 1.1, 1.2)

```
RUN:    npm run dev
PASS:   Terminal shows Vite dev server at http://localhost:5173 (no crash)
```

### S1.2 — Page loads with dark theme (Task 1.7)

```
RUN:    Open http://localhost:5173
CHECK:  Background is near-black (#0a0a0a), text is light gray
CHECK:  "Skill Forge" header visible
CHECK:  Empty state message visible ("Paste a conversation..." or similar)
PASS:   Dark-themed UI renders, no white flash
```

### S1.3 — Two-panel layout (Task 1.7)

```
CHECK:  Left panel (~60% width) contains ingestion zone stub + chat input
CHECK:  Right panel (~40% width) shows placeholder content
CHECK:  Ingestion zone is visible as a collapsible/stub element
PASS:   Both panels render side-by-side
```

### S1.4 — Chat round-trip with streaming (Task 1.4, 1.7)

```
RUN:    Type "hello" in chat input → press Enter
CHECK:  User message appears right-aligned immediately
CHECK:  After 1-3s, assistant response streams in left-aligned (characters appear progressively)
CHECK:  Blinking cursor visible during streaming, disappears when done
PASS:   Full round-trip: user → Agent → Workers AI → streaming → displayed
```

### S1.5 — WebSocket stable (Task 1.7)

```
CHECK:  Open browser DevTools → Network → WS tab
CHECK:  WebSocket connection to the Agent is open (status 101)
CHECK:  No repeated connect/disconnect cycling
PASS:   Single stable WebSocket connection
```

### S1.6 — Chat persistence across refresh (Task 1.4)

```
RUN:    Send 2-3 messages → wait for responses → hard refresh (Ctrl+R)
CHECK:  Previous messages reappear after refresh
PASS:   Chat history restored from SQLite
```

### S1.7 — Ingest stub responds (Task 1.4)

```
RUN:    Type "/ingest test conversation" → Enter
CHECK:  Error message appears: "not implemented yet" or similar
PASS:   Agent receives and routes ingest message correctly (even though stub)
```

### S1.8 — Health API (Task 1.4)

```
RUN:    Navigate to http://localhost:5173/api/health (or curl)
CHECK:  Returns JSON: {"status":"ok","skills":0}
PASS:   HTTP endpoint works alongside WebSocket
```

---

## Day 1 Gate (must pass before Day 2)

| # | Criterion | Test |
|---|-----------|------|
| G1.1 | TypeScript compiles | U1.1 |
| G1.2 | `npm run dev` starts | S1.1 |
| G1.3 | 3 SQL tables created | I1.1 |
| G1.4 | Chat round-trip with streaming | S1.4 |
| G1.5 | Chat persists across refresh | S1.6 |
| G1.6 | WebSocket connects and stays open | S1.5 |
| G1.7 | `/api/health` returns JSON | S1.8 |
| G1.8 | Workflow class compiles | I1.7 |

**All 8 gates must pass. If any fail, do not proceed to Day 2.**
