# Day 3 Test Plan — Refinement Loop + Skill CRUD

> Covers tasks 3.1–3.7 from sprint-plan.md
> Dependencies: Day 1 (Agent, SQL) + Day 2 (ingestion produces drafts to refine)
> Updated: 2026-03-03 (post-ingestion redesign — tools replace commands, no pattern cards)

---

## Unit Tests

### U3.1 — SQL search query construction (Task 3.4)

```
TEST: Search by description keyword
SETUP: 3 skills in SQLite, one with "React hooks" in description
INPUT: query = "React"
PASS:  SQL LIKE query returns the matching skill

TEST: Search by tag
SETUP: Skills tagged ["frontend"], ["backend"], ["frontend"]
INPUT: query = "frontend"
PASS:  Returns 2 skills

TEST: Search by trigger_patterns
SETUP: Skill with trigger_pattern containing "migration"
INPUT: query = "migration"
PASS:  Returns the matching skill

TEST: No match → empty result
SETUP: 5 skills, none matching "quantum"
INPUT: query = "quantum"
PASS:  Returns empty array (no fallback — SQL-only search)
```

---

## Integration Tests

### I3.1 — Refine loop: feedback → updated draft (Task 3.1)

```
TEST: refineSkill tool returns current skill context for LLM refinement
NOTE:  Refine is invoked via onChatMessage when the LLM calls the refineSkill tool.
       The tool returns the current skill's metadata + content as context.
       The LLM then generates a refined version using REFINE_PROMPT.
SETUP: Agent has a draftSkill in state
RUN:   User sends feedback like "Add error handling to step 3"
       → LLM calls refineSkill tool → tool returns skill context
       → LLM generates updated skill in response
CHECK: Response includes refined skill content
PASS:  Refinement loop works via tool + LLM

TEST: Multiple refine rounds accumulate changes
RUN:   Refine round 1 → get updated draft → Refine round 2 on the updated draft
PASS:  Round 2 operates on the output of round 1 (not the original)
```

### I3.2 — Skill save on approve (Task 3.2)

```
TEST: "approve" writes skill to SQLite
SETUP: Agent has a draftSkill + synthesizedSkill in state
RUN:   agent.onMessage(conn, '{"type":"approve","skillName":"react-debug"}')
CHECK: SELECT * FROM skills WHERE name = 'react-debug'
PASS:  Row exists with correct content, tags, trigger_patterns

TEST: Approve creates conversation_skill_link
CHECK: SELECT * FROM conversation_skill_links WHERE skill_name = 'react-debug'
PASS:  Link to source conversation exists

TEST: Approve updates state
CHECK: agent.state.skills includes the new skill
CHECK: agent.state.draftSkill === null
CHECK: agent.state.synthesizedSkill === null
CHECK: agent.state.ingestionStatus === "idle"
PASS:  State reflects saved skill, draft cleared
```

### I3.3 — Skill CRD operations (Task 3.3)

```
NOTE: Only Create, Read, Delete implemented. No Update endpoint.

TEST: Create — approve saves skill with metadata
SETUP: Complete ingestion pipeline → draft skill
RUN:   Approve the draft
PASS:  Skill created with name, description, tags, version "1.0.0"

TEST: Read (List) — listSkills tool returns all skills with metadata
SETUP: 3 skills in SQLite
RUN:   LLM calls listSkills tool
PASS:  Returns 3 SkillMetadata objects with correct fields

TEST: Read (Search) — searchSkills tool queries by keyword
SETUP: Skills in SQLite with various tags/descriptions
RUN:   LLM calls searchSkills tool with { query: "React" }
PASS:  Returns matching skills via SQL LIKE on name/description/tags/trigger_patterns

TEST: Delete — removes skill and links
RUN:   agent.onMessage(conn, '{"type":"delete_skill","skillName":"react-debug"}')
CHECK: SELECT * FROM skills WHERE name = 'react-debug' → 0 rows
CHECK: SELECT * FROM conversation_skill_links WHERE skill_name = 'react-debug' → 0 rows
PASS:  Skill and its links are removed

TEST: Delete non-existent skill → error
RUN:   Delete "nonexistent-skill"
PASS:  Error message returned, no crash
```

### I3.4 — Search end-to-end (Task 3.4)

```
TEST: searchSkills tool finds relevant skill via SQL LIKE
NOTE:  Search is SQL-only (no LLM summarization). SEARCH_PROMPT is defined
       but not currently used. The tool queries skills table directly.
SETUP: 3 skills in SQLite
RUN:   LLM calls searchSkills tool with { query: "React state management" }
CHECK: Tool returns matching skill metadata
CHECK: LLM formats results conversationally in its response
PASS:  Search returns relevant results

TEST: Search with no matches
SETUP: Empty skills table
RUN:   LLM calls searchSkills tool with any query
CHECK: Tool returns empty result
CHECK: LLM responds "no skills match" and may suggest ingesting conversations
PASS:  Empty search handled gracefully
```

### I3.5 — Chat history persistence (Task 3.6) — Framework-managed

```
NOTE: Chat history is managed internally by AIChatAgent (this.messages).
      There is no separate chat_history table or loadChatHistory() method.
      This is a framework concern, not application-level code we test directly.
      Verified implicitly by S3.6 (full loop persistence smoke test).
```

### I3.6 — Graph data updated on skill save (Task 3.2 → Day 4 prep)

```
TEST: After approve, state.graphData includes the new skill as a node
SETUP: Save a skill
CHECK: agent.state.graphData.nodes includes node with id === skill name
NOTE:  computeGraphData() is in src/graph.ts, called from handleApprove() in server.ts
PASS:  Graph data automatically recomputed on skill change
```

---

## Smoke Tests (Manual — Browser)

### S3.1 — Refine draft in chat (Task 3.1, 3.7)

```
RUN:    Complete an ingestion → get a draft skill
RUN:    In chat panel, type feedback like "Add a step for error handling"
CHECK:  LLM calls refineSkill tool to get current skill context
CHECK:  Streaming response shows updated skill content
PASS:   Interactive refinement loop works via tool
```

### S3.2 — Approve and save skill (Task 3.2, 3.7)

```
RUN:    After reviewing draft, click "Approve & Save" in ingestion panel
CHECK:  Skill appears in the skill list (verify via "What skills do I have?" in chat)
CHECK:  Draft cleared from state, ingestion panel resets to idle
CHECK:  Success confirmation sent via WebSocket
PASS:   Skill persisted to SQLite
```

### S3.3 — Search finds saved skill (Task 3.4)

```
RUN:    Type "search for [keyword from saved skill]" in chat
CHECK:  LLM calls searchSkills tool
CHECK:  Response references the saved skill by name
PASS:   Search works on persisted data
```

### S3.4 — Delete skill (Task 3.3)

```
RUN:    Delete a skill (via WebSocket message from UI)
CHECK:  Skill no longer appears in list
CHECK:  Search no longer finds it
CHECK:  Graph updates (if visible)
PASS:   Clean deletion
```

### S3.5 — Full loop persistence (Task 3.6)

```
RUN:    Ingest → refine → approve → close browser tab entirely
RUN:    Reopen http://localhost:5173
CHECK:  Skill still exists in repository
CHECK:  Chat history restored
CHECK:  Search still finds the skill
PASS:   Full data persistence across sessions
```

### S3.6 — Skill preview (Task 3.7)

```
CHECK:  When a draft skill is generated, ingestion panel shows:
        - Skill name, description, tags, key decisions
        - Full markdown draft rendered
        - Approve/reject buttons
NOTE:   SkillPreview.tsx component not yet built (planned for Day 4).
        Draft preview currently rendered inline in IngestionPanel.
PASS:   Skill preview is readable and actionable
```

---

## Day 3 Gate (must pass before Day 4)

| # | Criterion | Test |
|---|-----------|------|
| G3.1 | Refine tool provides context for LLM refinement | I3.1 |
| G3.2 | Approve writes skill to SQLite with links | I3.2 |
| G3.3 | CRD (create, read, delete) all work | I3.3 |
| G3.4 | Search returns relevant results via SQL | I3.4 |
| G3.5 | Chat history persists across restart | S3.5 (framework-managed, verified by smoke test) |
| G3.6 | Graph data updates on skill change | I3.6 |
| G3.7 | Full loop in browser: ingest → refine → approve → search → persists | S3.5 |

**All 7 gates must pass. If any fail, do not proceed to Day 4.**
