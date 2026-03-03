# Day 2 Test Plan — Ingestion Pipeline + Panel

> Covers tasks 2.1–2.9 from sprint-plan.md
> Dependencies: Day 1 gate passed (Agent, SQL, WebSocket, frontend shell)

---

## Unit Tests

### U2.1 — chunkConversation() basics (Task 2.1)

```
TEST: Normal multi-turn conversation splits into chunks ≤ 2500 tokens
INPUT: 5000-word conversation with "Human:" / "Assistant:" turns
PASS:  Returns 2+ chunks, each ≤ 2500 estimated tokens (word_count * 1.3)

TEST: Short conversation returns single chunk
INPUT: 200-word conversation
PASS:  Returns array with 1 element, content === original text

TEST: Empty string returns single-element array
INPUT: ""
PASS:  Returns [""] or [input] (non-empty array, no crash)
```

### U2.2 — chunkConversation() edge cases (Task 2.1)

```
TEST: Single oversized turn (> 2500 tokens)
INPUT: One "Human:" turn with 5000 words, no other turns
PASS:  Returns at least 1 chunk (doesn't hang or return empty)

TEST: Various turn markers recognized
INPUT: Conversation using "User:", "Human:", "Assistant:", "AI:", "Claude:" prefixes
PASS:  Splits on all recognized markers, no empty chunks

TEST: No turn markers (raw text)
INPUT: Plain prose with no "Human:"/"Assistant:" markers
PASS:  Returns the full text as a single chunk (graceful fallback)

TEST: Consecutive empty turns
INPUT: "Human:\n\nAssistant:\n\nHuman:\n\n"
PASS:  No crash, filters out empty strings
```

### U2.3 — Pattern JSON validation (Task 2.3)

```
TEST: Valid pattern array passes validation
INPUT: [{"name":"x","description":"d","evidence":["e"],"completeness":"complete","tags":["t"]}]
PASS:  Validation returns true

TEST: Missing required field fails
INPUT: [{"name":"x"}]  (missing description, evidence, completeness, tags)
PASS:  Validation returns false or throws with field name

TEST: Invalid completeness value fails
INPUT: [{"name":"x","description":"d","evidence":[],"completeness":"maybe","tags":[]}]
PASS:  Validation rejects "maybe" — only "complete"/"partial"/"fragment" allowed

TEST: Non-array response fails
INPUT: {"name":"x","description":"d"}  (object, not array)
PASS:  Validation returns false
```

### U2.4 — Pattern deduplication (Task 2.3)

```
TEST: Exact name duplicates are merged
INPUT: [{name:"react-debug",...}, {name:"react-debug",...}]
PASS:  Returns 1 pattern

TEST: Similar names (Levenshtein < 3) are merged
INPUT: [{name:"api-error",...}, {name:"api-errors",...}]
PASS:  Returns 1 pattern (kept the first or the more complete one)

TEST: Different patterns preserved
INPUT: [{name:"react-debug",...}, {name:"sql-optimization",...}]
PASS:  Returns 2 patterns
```

### U2.5 — Crossref verdict validation (Task 2.4)

```
TEST: Valid verdict array passes
INPUT: [{"pattern_name":"x","verdict":"new","target_skill":null,"reason":"r","new_information":null}]
PASS:  Validation returns true

TEST: Invalid verdict value fails
INPUT: [{"pattern_name":"x","verdict":"maybe",...}]
PASS:  Rejects — only "new"/"update"/"duplicate" allowed

TEST: "update" verdict requires target_skill
INPUT: [{"pattern_name":"x","verdict":"update","target_skill":null,...}]
PASS:  Validation warns or fails (update without target is meaningless)
```

---

## Integration Tests

### I2.1 — Workflow Step 1: chunking executes (Task 2.2)

```
TEST: Workflow step 1 calls chunkConversation and returns chunks
SETUP: Mock WorkflowStep, provide 3000-word conversation
RUN:   step.do("chunk-conversation", ...)
PASS:  Returns string array with 2+ chunks
```

### I2.2 — Workflow Step 2: extract with mock AI (Task 2.3)

```
TEST: Extract step calls Workers AI and parses JSON response
SETUP: Mock AI returns valid pattern JSON
RUN:   step.do("extract-patterns", ...)
PASS:  Returns ExtractedPattern[], each has required fields

TEST: Extract step retries on invalid JSON
SETUP: Mock AI returns "Here are the patterns: [...]" (wrapped in prose)
       Second call returns clean JSON
RUN:   step.do("extract-patterns", ...)
PASS:  Retry succeeds, returns valid patterns
```

### I2.3 — Workflow Step 3: crossref with mock AI (Task 2.4)

```
TEST: Crossref step compares patterns against existing skills
SETUP: Mock AI returns verdicts, mock SQL has 2 existing skills
RUN:   step.do("crossref-skills", ...)
PASS:  Returns CrossrefVerdict[] with correct verdicts

TEST: Empty skill repo → all patterns are "new"
SETUP: Mock AI, empty skills table
PASS:  All verdicts are "new"
```

### I2.4 — Workflow Step 4: draft with mock AI (Task 2.5)

```
TEST: Draft step generates skill markdown for "new" patterns only
SETUP: Mock AI returns skill markdown, verdicts have 2 "new" + 1 "duplicate"
RUN:   step.do("draft-skills", ...)
PASS:  Returns 2 draft strings (skips duplicate)
```

### I2.5 — Full Workflow pipeline (Task 2.2–2.5)

```
TEST: All 4 steps execute in sequence without error
SETUP: Mock AI for all steps, 2000-word test conversation
RUN:   workflow.run(event, step)
PASS:  Returns { chunks: N, patterns: [...], verdicts: [...], drafts: [...] }
       All arrays are non-empty
```

### I2.6 — Agent triggers Workflow (Task 2.6)

```
TEST: Agent onMessage "ingest" triggers INGESTION_WORKFLOW.create()
SETUP: Mock Workflow binding
RUN:   agent.onMessage(conn, '{"type":"ingest","content":"conversation text..."}')
PASS:  Workflow.create() called with payload containing conversationText
       conn receives { type: "ingestion_started", workflowId: "..." }
```

### I2.7 — Agent state updates on pipeline completion (Task 2.6)

```
TEST: When pipeline returns results, Agent updates state
SETUP: Simulate Workflow returning patterns + drafts
RUN:   Agent processes Workflow results
CHECK: agent.state.pendingPatterns is non-empty array
CHECK: agent.state.ingestionStatus === "complete"
PASS:  State contains extracted patterns for user review
```

### I2.8 — Error handling: JSON retry (Task 2.9)

```
TEST: In-code retry on malformed JSON before Workflow-level retry
SETUP: Mock AI returns invalid JSON first call, valid JSON second call
RUN:   Workflow extract step
PASS:  Returns valid patterns (retry succeeded without step-level retry)

TEST: Both retries fail → step throws → Workflow retries at step level
SETUP: Mock AI returns garbage on all calls
PASS:  Step throws error (message includes "Failed to parse")
```

### I2.9 — Error handling: empty extraction (Task 2.9)

```
TEST: If Prompt 1 returns [], feedback message is generated
SETUP: Mock AI returns "[]"
RUN:   Workflow extract step
PASS:  Returns { patterns: [], message: "No reusable patterns found..." }
```

---

## Smoke Tests (Manual — Browser)

### S2.1 — Ingestion Panel renders (Task 2.7)

```
RUN:    Open http://localhost:8787
CHECK:  Ingestion zone visible at top of left panel (collapsed or expanded)
CHECK:  Contains text area or paste region
CHECK:  "Start Analysis" button (or similar) visible
CHECK:  Collapse/expand toggle works
PASS:   Ingestion Panel is a distinct UI zone, separate from chat
```

### S2.2 — Paste and submit conversation (Task 2.7)

```
RUN:    Expand ingestion panel → paste a multi-turn AI conversation
RUN:    Click "Start Analysis"
CHECK:  Progress bar or status indicator appears
CHECK:  Status updates as pipeline steps execute (e.g., "Chunking...", "Extracting patterns...")
PASS:   Ingestion initiated, visual feedback shown
```

### S2.3 — Pattern cards display (Task 2.8)

```
RUN:    Wait for ingestion to complete
CHECK:  Pattern cards appear in the ingestion panel area
CHECK:  Each card shows: name, description, tags, completeness
CHECK:  Each card has confirm/reject controls
PASS:   Extracted patterns shown for user review
```

### S2.4 — Confirm patterns → draft skill (Task 2.8)

```
RUN:    Confirm 1+ patterns
CHECK:  Right panel shows draft skill preview (or draft appears in chat)
CHECK:  Draft follows the skill schema (frontmatter + sections)
PASS:   Pipeline end-to-end: paste → extract → confirm → draft
```

### S2.5 — Chat works during ingestion (Task 2.7)

```
RUN:    Start an ingestion (paste + analyze)
RUN:    While ingestion is running, type a chat message
CHECK:  Chat response comes back normally (streaming)
CHECK:  Ingestion progress continues independently
PASS:   Chat and ingestion are independent — no blocking
```

### S2.6 — Drag-and-drop file upload (Task 2.7)

```
RUN:    Drag a .md or .json file onto the ingestion panel
CHECK:  File content is loaded into the text area
CHECK:  "Start Analysis" can be clicked to begin ingestion
PASS:   File upload works as alternative to paste
```

### S2.7 — Error display (Task 2.9)

```
RUN:    Paste very short text (e.g., "hello") → start analysis
CHECK:  Error or "no patterns found" message appears in ingestion panel (NOT in chat)
PASS:   Errors route to the correct panel
```

---

## Day 2 Gate (must pass before Day 3)

| # | Criterion | Test |
|---|-----------|------|
| G2.1 | chunkConversation() handles normal + edge cases | U2.1, U2.2 |
| G2.2 | Workflow steps execute with mock AI | I2.2, I2.3, I2.4 |
| G2.3 | Full pipeline returns patterns + drafts | I2.5 |
| G2.4 | Agent triggers Workflow on "ingest" message | I2.6 |
| G2.5 | State updates with pendingPatterns | I2.7 |
| G2.6 | JSON retry works | I2.8 |
| G2.7 | Ingestion Panel renders as separate UI zone | S2.1 |
| G2.8 | End-to-end: paste → patterns → confirm → draft | S2.4 |

**All 8 gates must pass. If any fail, do not proceed to Day 3.**
