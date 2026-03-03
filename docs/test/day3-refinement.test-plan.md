# Day 3 Test Plan — Refinement Loop + Skill CRUD

> Covers tasks 3.1–3.7 from sprint-plan.md
> Dependencies: Day 1 (Agent, SQL) + Day 2 (ingestion produces drafts to refine)

---

## Unit Tests

### U3.1 — Command parsing (Task 3.5)

```
TEST: "/ingest [text]" parsed correctly
INPUT: "/ingest Here is my conversation..."
PASS:  Returns { type: "ingest", content: "Here is my conversation..." }

TEST: "/search [query]" parsed correctly
INPUT: "/search react hooks"
PASS:  Returns { type: "search", query: "react hooks" }

TEST: "/skills" parsed as list command
INPUT: "/skills"
PASS:  Returns { type: "list_skills" } or equivalent

TEST: "/skill react-debug" parsed as view command
INPUT: "/skill react-debug"
PASS:  Returns { type: "view_skill", name: "react-debug" }

TEST: Plain text without "/" prefix → chat
INPUT: "How do I use hooks?"
PASS:  Returns { type: "chat", content: "How do I use hooks?" }

TEST: Unknown command returns error hint
INPUT: "/unknown"
PASS:  Returns error message listing available commands
```

### U3.2 — SQL search pre-filter (Task 3.4)

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

TEST: No match → fallback returns top skills by usage
SETUP: 5 skills, none matching "quantum"
INPUT: query = "quantum"
PASS:  Returns up to 20 skills ordered by usage_count DESC (fallback)
```

### U3.3 — Skill frontmatter parsing (Task 3.2)

```
TEST: Parse valid skill markdown with YAML frontmatter
INPUT: "---\nname: test-skill\ndescription: ...\n---\n# Title\n## Overview..."
PASS:  Extracted name, description, tags, etc. match frontmatter values

TEST: Missing required frontmatter field → identified
INPUT: Skill markdown missing "trigger_patterns"
PASS:  Returns list of missing fields: ["trigger_patterns"]
```

---

## Integration Tests

### I3.1 — Refine loop: feedback → updated draft (Task 3.1)

```
TEST: Prompt 4 (Refine) returns updated skill with change summary
SETUP: Mock AI with current skill + user feedback
RUN:   agent.onMessage(conn, '{"type":"refine","feedback":"Add error handling to Process step 3"}')
CHECK: conn receives chunks (streaming) followed by "done"
CHECK: Response includes one-sentence summary + full updated skill markdown
PASS:  Draft is updated, original sections preserved except the changed one

TEST: Multiple refine rounds accumulate changes
RUN:   Refine round 1 → get updated draft → Refine round 2 on the updated draft
PASS:  Round 2 operates on the output of round 1 (not the original)
```

### I3.2 — Skill save on approve (Task 3.2)

```
TEST: "approve" writes skill to SQLite
SETUP: Agent has a draftSkill in state
RUN:   agent.onMessage(conn, '{"type":"approve","skillName":"react-debug"}')
CHECK: SELECT * FROM skills WHERE name = 'react-debug'
PASS:  Row exists with correct content, tags, trigger_patterns

TEST: Approve creates conversation_skill_link
CHECK: SELECT * FROM conversation_skill_links WHERE skill_name = 'react-debug'
PASS:  Link to source conversation exists

TEST: Approve updates state
CHECK: agent.state.skills includes the new skill
CHECK: agent.state.draftSkill === null
CHECK: agent.state.ingestionStatus === "idle"
PASS:  State reflects saved skill, draft cleared
```

### I3.3 — Skill CRUD operations (Task 3.3)

```
TEST: List — returns all skills with metadata
SETUP: 3 skills in SQLite
RUN:   Request skill list (via message or command)
PASS:  Returns 3 SkillMetadata objects with correct fields

TEST: View — returns full skill content
RUN:   Request single skill by name
PASS:  Returns complete markdown content

TEST: Update — modifies existing skill
SETUP: Skill "react-debug" exists with version "1.0.0"
RUN:   Update skill content, version becomes "1.1.0"
PASS:  SELECT shows updated content and version

TEST: Delete — removes skill and links
RUN:   agent.onMessage(conn, '{"type":"delete_skill","skillName":"react-debug"}')
CHECK: SELECT * FROM skills WHERE name = 'react-debug' → 0 rows
CHECK: SELECT * FROM conversation_skill_links WHERE skill_name = 'react-debug' → 0 rows
PASS:  Skill and its links are removed

TEST: Delete non-existent skill → error
RUN:   Delete "nonexistent-skill"
PASS:  Error message returned, no crash
```

### I3.4 — Search end-to-end with mock AI (Task 3.4)

```
TEST: Search finds relevant skill via SQL + LLM summary
SETUP: 3 skills in SQLite, mock AI
RUN:   agent.onMessage(conn, '{"type":"search","query":"React state management"}')
CHECK: conn receives streaming response referencing the matching skill by name
PASS:  Search returns conversational answer citing specific skills

TEST: Search with no matches
SETUP: Empty skills table
RUN:   Search for anything
PASS:  Response says "no skills match" and suggests ingesting conversations
```

### I3.5 — Chat history persistence (Task 3.6)

```
TEST: Chat history survives Agent restart
SETUP: Send 5 messages, verify stored
RUN:   Simulate Agent restart (re-run onStart)
CHECK: loadChatHistory() returns the 5 messages
PASS:  Messages restored from SQLite

TEST: Chat history limited to last 50
SETUP: Insert 60 chat messages
RUN:   loadChatHistory()
PASS:  Returns exactly 50 messages (most recent), ordered chronologically
```

### I3.6 — Graph data updated on skill save (Task 3.2 → Day 4 prep)

```
TEST: After approve, state.graphData includes the new skill as a node
SETUP: Save a skill
CHECK: agent.state.graphData.nodes includes node with id === skill name
PASS:  Graph data automatically recomputed on skill change
```

---

## Smoke Tests (Manual — Browser)

### S3.1 — Refine draft in chat (Task 3.1, 3.7)

```
RUN:    Complete an ingestion → get a draft skill
RUN:    In chat panel, type feedback like "Add a step for error handling"
CHECK:  Streaming response shows change summary + updated skill
CHECK:  Skill preview card (right panel or in chat) updates with new content
PASS:   Interactive refinement loop works
```

### S3.2 — Approve and save skill (Task 3.2, 3.7)

```
RUN:    After refining, click "Approve" (or type approval)
CHECK:  Skill appears in the skill list / repository
CHECK:  Draft cleared from state
CHECK:  Success confirmation in chat or UI
PASS:   Skill persisted to SQLite
```

### S3.3 — Search finds saved skill (Task 3.4)

```
RUN:    Type "/search [keyword from saved skill]" in chat
CHECK:  Response references the saved skill by name
CHECK:  Skill can be opened/viewed from search result
PASS:   Search works on persisted data
```

### S3.4 — Delete skill (Task 3.3)

```
RUN:    Delete a skill (via command or UI button)
CHECK:  Skill no longer appears in list
CHECK:  Search no longer finds it
CHECK:  Graph updates (if visible)
PASS:   Clean deletion
```

### S3.5 — Commands work (Task 3.5)

```
RUN:    "/skills" → shows skill list
RUN:    "/skill [name]" → shows full skill
RUN:    "/search [query]" → search results
RUN:    "/ingest [text]" → triggers ingestion
CHECK:  Each command routes correctly, no "unknown command" errors
PASS:   All 4 commands functional
```

### S3.6 — Full loop persistence (Task 3.6)

```
RUN:    Ingest → refine → approve → close browser tab entirely
RUN:    Reopen http://localhost:8787
CHECK:  Skill still exists in repository
CHECK:  Chat history restored
CHECK:  "/search" still finds the skill
PASS:   Full data persistence across sessions
```

### S3.7 — Skill preview card (Task 3.7)

```
CHECK:  When a draft or saved skill is selected, right panel shows:
        - Skill name and metadata (tags, version, usage count)
        - Full markdown content rendered
        - Approve/reject buttons (for drafts)
PASS:   Skill preview is readable and actionable
```

---

## Day 3 Gate (must pass before Day 4)

| # | Criterion | Test |
|---|-----------|------|
| G3.1 | Refine loop produces updated draft | I3.1 |
| G3.2 | Approve writes skill to SQLite with links | I3.2 |
| G3.3 | CRUD all 4 operations work | I3.3 |
| G3.4 | Search returns relevant results | I3.4 |
| G3.5 | Chat history persists across restart | I3.5 |
| G3.6 | Graph data updates on skill change | I3.6 |
| G3.7 | Full loop in browser: ingest → refine → approve → search → persists | S3.6 |

**All 7 gates must pass. If any fail, do not proceed to Day 4.**
