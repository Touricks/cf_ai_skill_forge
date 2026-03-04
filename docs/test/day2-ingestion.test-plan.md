# Day 2 Test Plan — Ingestion Pipeline + Turn Selection

> Covers the ingestion pipeline: client-side turn parsing, 3-step Workflow, and IngestionPanel UI
> Dependencies: Day 1 gate passed (Agent, SQL, WebSocket, frontend shell)
> Updated: 2026-03-03 (post-ingestion redesign — turn selection replaces chunking + pattern cards)

---

## Unit Tests

### U2.1 — parseConversationTurns() basics (IngestionPanel.tsx) ✅ DONE

```
STATUS: 18 tests in test/ingestion-panel.test.ts — ALL PASS

TEST: Multi-turn conversation splits correctly
INPUT: "User: help me\nAssistant: I can help with that"
PASS:  Returns 2 ConversationTurn objects with correct speakers and bodies

TEST: Various speaker prefixes recognized
INPUT: Conversation using "User:", "Human:", "Assistant:", "Claude:", "GPT:", "Gemini:", "AI:" prefixes
PASS:  Each speaker correctly identified

TEST: No speaker markers → single "Unknown" turn
INPUT: "Just some plain text with no speaker markers"
PASS:  Returns 1 turn with speaker === "Unknown"

TEST: Token estimation uses Math.ceil(wordCount * 1.3)
INPUT: "User: hello world\nAssistant: hi back"
PASS:  turns[1].estimatedTokens === Math.ceil(2 * 1.3) === 3

TEST: Sequential indices from 0
INPUT: Multi-turn conversation
PASS:  turns[0].index === 0, turns[1].index === 1, etc.
```

### U2.2 — speakerVariant() ✅ DONE

```
STATUS: Tested in test/ingestion-panel.test.ts — ALL PASS

TEST: "User"/"Human" → "primary"
TEST: "Assistant"/"Claude"/"GPT"/"Gemini"/"AI" → "outline"
TEST: Unknown speaker → "secondary"
TEST: Case insensitive matching
```

### U2.3 — validateSynthesizedSkill() ✅ DONE

```
STATUS: 12 tests in test/workflow.test.ts — ALL PASS

TEST: Valid object → returns typed SynthesizedSkill
TEST: Wrapped in array → extracts first element
TEST: Empty array → returns null
TEST: Missing name/description → returns null
TEST: Empty string name → returns null
TEST: Tags as non-array → returns empty tags
TEST: key_decisions filtering → removes invalid entries, keeps valid
TEST: Trims name and description
```

### U2.4 — validateSingleVerdict() ✅ DONE

```
STATUS: 10 tests in test/workflow.test.ts — ALL PASS

TEST: Valid verdict → returns typed CrossrefVerdict
TEST: Wrapped in array → extracts first element
TEST: Invalid verdict value ("maybe") → returns null
TEST: Missing pattern_name/reason → returns null
TEST: Accepts all valid verdict values: "new", "update", "duplicate"
TEST: target_skill null vs string → both preserved
TEST: new_information null vs string → both preserved
```

### U2.5 — extractAiResponse() + parseJsonResponse() ✅ DONE

```
STATUS: 17 tests in test/workflow.test.ts — ALL PASS

extractAiResponse:
- String input → returns as-is
- { response: "text" } → returns "text"
- { response: [1,2,3] } → returns JSON stringified
- null / undefined / {} → returns ""

parseJsonResponse:
- Valid JSON object/array → parses
- Markdown-fenced JSON → extracts and parses
- JSON with leading prose → bracket extraction
- Nested brackets → outermost extracted
- Invalid input / empty string → throws "Failed to parse JSON"
```

---

## Integration Tests

### I2.1 — Workflow Step 1: synthesize-skill (Task 2.2)

```
TEST: Synthesize step calls Workers AI with selected turns and returns SynthesizedSkill
SETUP: Mock AI returns valid SynthesizedSkill JSON
RUN:   step.do("synthesize-skill", ...)
PASS:  Returns { synthesizedSkill } with name, description, tags, trigger_patterns, key_decisions

TEST: Synthesize step handles skillHint parameter
SETUP: Mock AI, workflow params include skillHint: "React error handling"
RUN:   step.do("synthesize-skill", ...)
CHECK: AI prompt includes the skill hint text
PASS:  Hint influences synthesis
```

### I2.2 — Workflow Step 2: crossref-skill (Task 2.3)

```
TEST: Crossref step compares synthesized skill against existing skills
SETUP: Mock AI returns verdict, params include existingSkillNames: ["react-debug"]
RUN:   step.do("crossref-skill", ...)
PASS:  Returns CrossrefVerdict with verdict in ["new", "update", "duplicate"]

TEST: Empty skill repo → verdict is "new"
SETUP: Mock AI, existingSkillNames: []
PASS:  Verdict is "new"
```

### I2.3 — Workflow Step 3: draft-skill (Task 2.4)

```
TEST: Draft step generates skill markdown for "new" verdict
SETUP: Mock AI returns markdown, verdict.verdict === "new"
RUN:   step.do("draft-skill", ...)
PASS:  Returns { draft: "# skill-name\n..." }

TEST: Draft step generates markdown for "update" verdict with existing context
SETUP: Mock AI, verdict.verdict === "update", target_skill provided
PASS:  Draft includes references to existing skill being updated

TEST: Draft step skips for "duplicate" verdict
SETUP: verdict.verdict === "duplicate"
PASS:  Returns { draft: null } or skip message
```

### I2.4 — Full Workflow pipeline (Task 2.2–2.4)

```
TEST: All 3 steps execute in sequence without error
SETUP: Mock AI for all steps, selected turns as input
RUN:   workflow.run(event, step)
PASS:  Returns { synthesizedSkill, verdict, draft }
       synthesizedSkill is non-null, verdict.verdict is valid, draft is string
```

### I2.5 — Agent triggers Workflow (Task 2.5)

```
TEST: Agent onMessage "ingest" triggers INGESTION_WORKFLOW.create()
SETUP: Mock Workflow binding
RUN:   agent.onMessage(conn, '{"type":"ingest","turns":["User: help\nAssistant: sure"],"skillHint":"debugging"}')
PASS:  Workflow.create() called with { selectedTurns, skillHint, existingSkillNames }
       conn receives { type: "ingestion_started", workflowId: "..." }
```

### I2.6 — Agent state updates on pipeline completion (Task 2.5)

```
TEST: When pipeline returns results, Agent updates state
SETUP: Simulate Workflow returning synthesizedSkill + verdict + draft
RUN:   Agent processes Workflow results (handleWorkflowComplete)
CHECK: agent.state.synthesizedSkill is non-null SynthesizedSkill
CHECK: agent.state.draftSkill is non-null string
CHECK: agent.state.ingestionStatus === "complete"
PASS:  State contains synthesized skill for user review
```

### I2.7 — Error handling: JSON retry (Task 2.8)

```
TEST: parseJsonResponse handles markdown-fenced LLM output
SETUP: LLM returns "```json\n{...}\n```"
PASS:  JSON extracted from fence, parsed correctly

TEST: parseJsonResponse handles prose-wrapped JSON
SETUP: LLM returns "Here is the result: {...} hope that helps"
PASS:  JSON extracted via bracket matching

TEST: Both layers fail → step throws → Workflow retries at step level
SETUP: LLM returns completely invalid text
PASS:  Step throws error (message includes "Failed to parse JSON")
```

### I2.8 — Error handling: synthesis failure (Task 2.8)

```
TEST: If synthesize step returns invalid skill, error message is generated
SETUP: Mock AI returns { name: "", description: "" } (validation fails)
PASS:  Error sent to client: "Failed to synthesize skill from selected turns"
```

---

## Smoke Tests (Manual — Browser)

### S2.1 — Ingestion Panel renders (Task 2.6)

```
RUN:    Open http://localhost:5173
CHECK:  "Ingest Conversation" button visible at top
CHECK:  Clicking opens panel with text area and file upload
PASS:   Ingestion Panel is a distinct UI zone, separate from chat
```

### S2.2 — Paste and parse turns (Task 2.6)

```
RUN:    Expand ingestion panel → paste a multi-turn AI conversation
RUN:    Click "Parse Turns"
CHECK:  Turn list appears with checkboxes, speaker badges, token counts
CHECK:  Token budget bar shows total selected vs 4000 limit
CHECK:  Turns auto-selected if within budget
PASS:   Turn parsing and selection UI works
```

### S2.3 — Turn selection + extract skill (Task 2.7)

```
RUN:    Select/deselect turns to stay within token budget
RUN:    Optionally add a skill hint in the text field
RUN:    Click "Extract Skill"
CHECK:  Progress bar appears showing workflow steps
CHECK:  Status updates as each step completes (synthesize → crossref → draft)
PASS:   Skill extraction initiated with selected turns
```

### S2.4 — Draft review + approve (Task 2.7)

```
RUN:    Wait for extraction to complete
CHECK:  Draft skill preview appears with:
        - Skill name, description, tags, key decisions
        - Full markdown draft rendered
        - "Approve & Save" and "Reject" buttons
RUN:    Click "Approve & Save"
CHECK:  Panel resets to idle state
CHECK:  Skill saved to SQLite (verify via chat: "What skills do I have?")
PASS:   End-to-end: paste → parse → select → extract → draft → approve
```

### S2.5 — Chat works during ingestion (Task 2.6)

```
RUN:    Start an ingestion (paste + parse + extract)
RUN:    While ingestion is running, type a chat message
CHECK:  Chat response comes back normally (streaming)
CHECK:  Ingestion progress continues independently
PASS:   Chat and ingestion are independent — no blocking
```

### S2.6 — File upload (Task 2.6)

```
RUN:    Click file upload or drag a .md/.txt file onto the ingestion panel
CHECK:  File content is loaded into the text area
CHECK:  "Parse Turns" can be clicked to begin turn parsing
PASS:   File upload works as alternative to paste
```

### S2.7 — Error display (Task 2.8)

```
RUN:    Select turns with very little content → click "Extract Skill"
CHECK:  Error message appears in ingestion panel (NOT in chat)
PASS:   Errors route to the correct panel
```

---

## Day 2 Gate (must pass before Day 3)

| # | Criterion | Test |
|---|-----------|------|
| G2.1 | parseConversationTurns() handles multi-turn + edge cases | U2.1 ✅ |
| G2.2 | validateSynthesizedSkill/Verdict handle LLM output | U2.3, U2.4 ✅ |
| G2.3 | Full 3-step pipeline returns skill + verdict + draft | I2.4 |
| G2.4 | Agent triggers Workflow on "ingest" message | I2.5 |
| G2.5 | State updates with synthesizedSkill + draftSkill | I2.6 |
| G2.6 | JSON parsing handles markdown fences + prose wrapping | I2.7 ✅ |
| G2.7 | IngestionPanel renders with turn selection UI | S2.1, S2.2 |
| G2.8 | End-to-end: paste → parse turns → select → extract → draft → approve | S2.4 |

**All 8 gates must pass. If any fail, do not proceed to Day 3.**
