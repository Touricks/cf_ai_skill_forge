# Integration Test Plan — Skill Forge

> Covers end-to-end flows across modules. Complements unit tests (81 tests in test/).
> Updated: 2026-03-04
> Execution: Playwright browser automation against `localhost:5173` or production URL

---

## IT-1. Ingestion E2E (MVP Core)

**Modules**: IngestionPanel → WebSocket → Agent.onMessage → Workflow → SQLite → setState → GraphView

**Primary input method**: `/copy k` command (pre-fills from current chat)

```
SETUP: Have an active chat with at least 3 message pairs
TEST:  Full ingestion flow via /copy command

STEP 1: Type `/copy 3` in chat input
CHECK:  Ingestion Panel opens, textarea pre-filled with last 3 turns
        Format: "User: ...\n\nAssistant: ...\n\n..."
        Parser identifies correct number of turns with User/Assistant speakers

STEP 2: Select at least 1 turn, add skill hint
CHECK:  Token count updates, selected turns highlighted

STEP 3: Click submit
CHECK:  Progress bar shows: extracting → cross-referencing → drafting (max 3 min)

STEP 4: Wait for completion
CHECK:  SKILL.md draft appears with: name, description, tags, trigger_patterns,
        key decisions, process steps

STEP 5: Click "Approve"
CHECK:  Panel resets to idle; graph shows new node; tags update in filter chips

STEP 6: Refresh page
CHECK:  Skill persists in graph; listSkills returns the new skill
```

**Failure scenarios**:
```
TEST:  /copy 0 — no action (no pre-fill)
TEST:  /copy 99 with only 2 messages — pre-fills all available, no crash
TEST:  Paste < 50 chars manually — error "Selected turns are too short"
```

---

## IT-2. Chat Tools Chain

**Modules**: InputArea → WebSocket → Agent.onChatMessage → streamText → tool() → SQLite → UI

**Prereq**: At least 1 saved skill

```
TEST 1: listSkills
INPUT:  "What skills do I have?"
CHECK:  listSkills tool triggered (ToolPartView shows)
        Returns skill table with name, description, tags, usage count

TEST 2: viewSkill
INPUT:  "Show me [skill-name]"
CHECK:  viewSkill tool triggered
        Returns full skill markdown content
        usage_count incremented by 1

TEST 3: searchSkills
INPUT:  "Search for [topic]"
CHECK:  searchSkills tool triggered
        Returns matching skills + AI-generated summary

TEST 4: refineSkill
INPUT:  "Refine [skill-name]: add a section about X"
CHECK:  refineSkill tool triggered
        Returns updated skill markdown with new section
        state.draftSkill updated

TEST 5: Streaming
CHECK:  All responses stream progressively (Streamdown rendering)
        Not loaded all at once
```

---

## IT-3. Graph State Sync

**Modules**: Agent.setState → WebSocket onStateUpdate → React state → GraphView → SkillPreview

**Prereq**: At least 2 saved skills

```
TEST 1: Node count matches skill count
CHECK:  Graph node count === skills array length

TEST 2: Live update on ingestion
ACTION: Ingest new skill via /copy k
CHECK:  Graph adds new node WITHOUT page refresh

TEST 3: Node click → detail
ACTION: Click a graph node
CHECK:  SkillPreview shows correct name/tags/description/metadata

TEST 4: Back navigation
ACTION: Click "Back to graph"
CHECK:  Returns to graph view

TEST 5: Delete skill
ACTION: Click node → SkillPreview → "Delete Skill"
CHECK:  Skill removed from graph; node count decreases by 1

TEST 6: Tag filter
ACTION: Click a tag chip
CHECK:  Non-matching nodes opacity = 0.15
        Matching nodes opacity = 1
        Edges between non-matching nodes opacity = 0.08

TEST 7: Persistence
ACTION: Refresh page
CHECK:  Graph nodes still present (SQLite persisted)
```

---

## IT-4. Dual Channel Parallel

**Modules**: useAgentChat (chat) + useAgent.send (ingestion) sharing one WebSocket

```
TEST:  Chat and ingestion run simultaneously

STEP 1: Start ingestion (submit turns)
CHECK:  Progress bar advancing

STEP 2: While ingestion is running, send a chat message
CHECK:  Chat responds normally, streaming works

STEP 3: Ingestion completes
CHECK:  Draft appears in Ingestion Panel
        Chat history unaffected
```

---

## IT-5. Persistence + Recovery

**Modules**: SQLite (skills/conversations/links) + Agent state + AIChatAgent messages

```
TEST 1: Skill persistence
ACTION: Ingest + approve a skill
ACTION: Refresh page
CHECK:  Skill in graph, listSkills returns it

TEST 2: Chat history persistence
ACTION: Send several chat messages
ACTION: Close and reopen browser tab
CHECK:  Chat history restored

TEST 3: Cross-session
ACTION: Close browser completely
ACTION: Reopen and navigate to app
CHECK:  Skills + graph + connection all restored
```

---

## IT-6. Error Resilience

**Modules**: server.ts try-catch → WebSocket error messages → UI error display

```
TEST 1: Short input
ACTION: Paste "hello" in Ingestion Panel, submit
CHECK:  Error "too short", panel doesn't crash

TEST 2: Delete nonexistent skill
ACTION: Send delete_skill with fake name via WebSocket
CHECK:  Returns "not found" error

TEST 3: View nonexistent skill
ACTION: Chat "Show me nonexistent-skill"
CHECK:  Tool returns "not found", chat continues normally

TEST 4: WebSocket disconnect
ACTION: Stop dev server
CHECK:  Yellow banner "Connection lost. Reconnecting..."

TEST 5: WebSocket reconnect
ACTION: Restart dev server
CHECK:  Banner disappears, status shows "Connected"
```

---

## IT-7. Responsive Layout

```
TEST 1: Desktop (1280px)
CHECK:  Left/right panels side by side, 60/40 split

TEST 2: Tablet (768px)
CHECK:  Same side-by-side layout (md breakpoint)

TEST 3: Mobile (375px)
CHECK:  Panels stacked vertically, each 50% height
        Both panels scrollable
        Border switches from left to top
```

---

## Priority

| Priority | Test | Reason |
|----------|------|--------|
| **P0** | IT-1 (Ingestion E2E) | MVP core function |
| **P0** | IT-2 (Chat tools) | Assignment requirement: LLM + user input |
| **P0** | IT-5 (Persistence) | Assignment requirement: Memory/State |
| **P1** | IT-3 (Graph sync) | Differentiating feature |
| **P1** | IT-4 (Dual channel) | Architecture correctness |
| **P2** | IT-6 (Error handling) | Robustness |
| **P2** | IT-7 (Responsive) | Polish |

---

## Gate Criteria

| Gate | Criteria | Pass Condition |
|------|----------|---------------|
| G-INT-1 | `/copy k` pre-fills Ingestion Panel | Turns parsed with correct speakers |
| G-INT-2 | Full ingestion via /copy → approve | Skill saved, graph updated |
| G-INT-3 | All 4 chat tools work | list, view, search, refine return valid results |
| G-INT-4 | Skills persist across refresh | Graph nodes present after F5 |
| G-INT-5 | Delete skill works | Node removed from graph |
| G-INT-6 | Error states don't crash | App remains functional after all error scenarios |
