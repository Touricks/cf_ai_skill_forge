# Skill Forge — Internal LLM Prompt Engineering Guide (v2)

> These are the prompts that run **inside** the Skill Forge app — called via Workers AI (Llama 3.3 70B).
> Each prompt corresponds to a step in the ingestion/drafting pipeline.
>
> **v2 changelog:** Added data flow via Agent SQL between prompts. Fixed JSON retry
> pattern. Added token limit verification note. Added prompt versioning via SQL.
> Clarified which prompts run in Workflow vs Agent.

---

## Architecture Overview: Where Each Prompt Runs

The frontend has two distinct UI entry points — the **Ingestion Panel** (dedicated paste/upload area) and the **Chat Panel** (conversational input). Both share one WebSocket connection to the same `ChatAgent` instance. The `AIChatAgent` framework has two separate handlers:

- **`onChatMessage`** — handles chat protocol messages (from `useAgentChat`). Uses `streamText()` + `tool()` for refine, search, list.
- **`onMessage`** — handles custom WebSocket messages (from `useAgent.send()`). Used for ingestion protocol only.

```
┌─ Ingestion Panel ─┐       ┌─ Chat Panel ──────────┐
│ Paste / upload     │       │ Chat, refine, search   │
│ conversation text  │       │ (natural language)      │
└────────┬──────────┘       └────────┬───────────────┘
         │ useAgent.send()           │ useAgentChat.sendMessage()
         │ { type: "ingest" }        │ (framework chat protocol)
         ▼                           ▼
      Agent.onMessage()           Agent.onChatMessage()
         │                           │
         │ type: "ingest"            │ streamText() + tool() calls
         │ type: "confirm_patterns"  │
         │ type: "approve"           ▼  ┌─── Agent (real-time, interactive) ───┐
         │ type: "delete_skill"         │                                       │
         │                              │  refineSkill tool → PROMPT 4          │
         │  Agent triggers:             │      └→ returns: updated skill md     │
         │  INGESTION_WORKFLOW          │                                       │
         │  .create(...)                │  searchSkills tool → PROMPT 5         │
         │                              │      └→ returns: conversational answer │
         ▼                              │                                       │
┌─── Cloudflare Workflow ──────┐        │  listSkills tool → SQL query          │
│   (auto-retry per step)      │        │      └→ returns: skill list           │
│                              │        │                                       │
│  STEP 1: Chunk (non-LLM)    │        └───────────────────────────────────────┘
│     └→ chunks to step state  │
│                              │
│  STEP 2: PROMPT 1 — EXTRACT  │
│     └→ pattern candidates[]  │
│                              │
│  STEP 3: PROMPT 2 — CROSSREF │
│     └→ { new[], update[],    │
│          duplicate[] }       │
│                              │
│  STEP 4: PROMPT 3 — DRAFT    │
│     └→ draft skill md(s)    │
│                              │
└──────────────┬───────────────┘
               │ Workflow returns results
               ▼
        Agent stores results in this.sql
        Agent calls this.setState → Ingestion Panel auto-updates
        (pendingPatterns, ingestionStatus, draftSkill)
        User reviews patterns in Ingestion Panel → confirms
        User refines drafts via Chat Panel → tool() calls
```

**Key distinctions:**
- Prompts 1-3 run inside Workflow steps (batch, with retry). Triggered from the **Ingestion Panel** via `onMessage`.
- Prompts 4-5 run inside the Agent (real-time, interactive, streaming). Triggered from the **Chat Panel** via `onChatMessage` as `tool()` definitions — the LLM decides when to invoke them based on user intent.
- State updates route to the correct UI panel: ingestion status → Ingestion Panel, chat responses → Chat Panel, graph/skill data → Right Panel.

---

## Data Flow via Agent SQL

Each prompt step reads inputs from and writes outputs to the Agent's embedded SQLite. This makes the pipeline **resumable** — if the user disconnects mid-ingestion, the Workflow completes independently, writes results to SQL, and the Agent can present them when the user reconnects.

```
conversations table                   skills table
┌──────────────────────┐             ┌──────────────────────┐
│ id                   │             │ name (PK)            │
│ raw_text        ←────── P1 reads   │ content         ←────── P3 writes, P4 updates
│ extracted_patterns ←── P1 writes   │ tags, triggers  ←────── P3 writes
└──────────┬───────────┘             │ source_conversations │
           │                         └──────────┬───────────┘
           │  conversation_skill_links           │
           │  ┌──────────────────────┐           │
           └──│ conversation_id      │───────────┘
              │ skill_name           │
              └──────────────────────┘
                    ↑ P3 writes (links conversation to new skill)

P2 reads: skills.name + skills.description + skills.tags + skills.trigger_patterns
P5 reads: skills.* (for search results)
```

**Benefit over v1's approach (passing JSON blobs between function calls):**
1. If a Workflow step fails and retries, it doesn't re-extract patterns already stored in SQL.
2. The Agent can show partial results to the user while later steps are still running.
3. No risk of exceeding function argument size limits with large JSON payloads.

---

## SYSTEM PROMPT — Copilot Persona (Always Active)

Injected as the `system` message in every Workers AI call (both Workflow steps and Agent calls).

```
You are Skill Forge, a developer skill architect. Your job is to help developers
capture, structure, and manage reusable problem-solving patterns ("skills") from
their AI conversation history.

Behavior rules:
- Be direct and efficient. State what you found, then suggest the next step.
- Never restate the user's input back to them.
- Never use hedging language: no "perhaps", "maybe", "it might be worth considering".
- When presenting analysis, use structured formats (tables, bullets, code blocks).
- When chatting, use short paragraphs — max 3 sentences per paragraph.
- Always reference specific content from the user's provided data. Never give generic advice.
- If you lack sufficient information to complete a task, say exactly what's missing and ask for it.

You have access to the user's skill repository. When relevant, reference existing skills by name.

Response format: Always respond in plain text or markdown. Never wrap your response in ```json
or ```yaml unless explicitly producing a skill definition.
```

### Design notes:

**Why "never restate"** — Instruction-tuned models love to parrot inputs ("You asked me to analyze your conversation about X..."). Wastes tokens and feels robotic. The ban forces the model to jump to value.

**Why "max 3 sentences per paragraph"** — For streaming responses (Prompts 4, 5 in Agent), short paragraphs create a snappier feel as text appears in real-time. For Workflow steps (Prompts 1-3), paragraph length doesn't matter since output is parsed programmatically — but keeping the system prompt consistent avoids confusion.

**Why "never hedge"** — The copilot's job is to be opinionated. If the model is uncertain, it should state uncertainty as fact ("I found 2 clear patterns and 1 ambiguous one") rather than hedging.

---

## PROMPT 1: EXTRACT — Pattern Identification

**Runs in:** Workflow Step 2
**Triggered by:** User pastes or uploads conversation text
**Called:** Once per conversation chunk

```
Analyze the following AI conversation and identify reusable skill patterns.

A "skill pattern" is a problem-solving approach, workflow, technique, or decision
framework that could be applied to similar problems in the future. It must be:
- SPECIFIC: Not generic advice, but a concrete method with clear steps
- REUSABLE: Applicable beyond this one conversation
- ACTIONABLE: Someone could follow it without additional context

For each pattern you find, extract:
1. name: A short kebab-case identifier (e.g., "react-state-migration", "api-error-handling-strategy")
2. description: One sentence explaining when this pattern applies
3. evidence: The exact quotes or exchanges from the conversation that demonstrate this pattern (use line numbers or turn numbers if available)
4. completeness: Rate as "complete" (could write a full skill from this alone), "partial" (needs more context), or "fragment" (just a hint, needs much more data)
5. tags: 2-4 categorical tags

Conversation to analyze:
---
{conversation_text}
---

Respond ONLY with a JSON array of pattern objects. No preamble, no explanation.
Example format:
[
  {
    "name": "pattern-name",
    "description": "When to use this pattern",
    "evidence": ["relevant quote 1", "relevant quote 2"],
    "completeness": "complete|partial|fragment",
    "tags": ["tag1", "tag2"]
  }
]
```

### Design notes:

**Why JSON output** — This runs in a Workflow step that programmatically stores results in `this.sql`. Markdown isn't parseable. The "No preamble" instruction fights Llama 3.3's tendency to add conversational wrappers.

**Why "evidence" as exact quotes** — Anti-hallucination mechanism. By requiring citation of specific exchanges, we can (a) show the user *why* a pattern was detected, and (b) build edges in the graph visualization (conversation → skill attribution). Evidence quotes are stored in `conversations.extracted_patterns` for later reference.

**Why three-level completeness** — Not all conversations contain full skills. The completeness rating drives pipeline behavior:
- `complete` → Workflow proceeds to Prompt 3 (Draft) immediately
- `partial` → Stored as seed in SQL, enriched when future conversations add evidence
- `fragment` → Stored but not surfaced to user until combined with other fragments

This directly solves the cross-session problem: conversation A yields "partial" → stored. Conversation B's pattern gets crossref'd → verdict "update" → Prompt 3 combines evidence from both.

**Chunking strategy** — Implemented as Workflow Step 1 (non-LLM):
1. Split conversation into turns (regex: `(?=(?:User|Human|Assistant|AI):)`)
2. Count tokens per turn (approximate: whitespace split × 1.3)
3. Group consecutive turns into blocks ≤ 2500 tokens
4. If a single turn exceeds 2500 tokens, truncate from middle (keep first + last 1000 tokens)
5. Each block is sent to Prompt 1 separately within the same Workflow step
6. Deduplicate across blocks by name similarity (Levenshtein distance < 3 → merge)

---

## PROMPT 2: CROSSREF — Compare Against Existing Skills

**Runs in:** Workflow Step 3
**Triggered by:** After Prompt 1 completes for all chunks
**Called:** Once (batch)

```
You are comparing newly extracted patterns against an existing skill repository.

EXISTING SKILLS in the repository:
---
{existing_skills_summary}
---

Format of each existing skill above:
- name: the skill identifier
- description: what it does
- tags: categories
- trigger_patterns: when it activates

NEWLY EXTRACTED PATTERNS:
---
{new_patterns_json}
---

For each new pattern, determine:
1. "new" — No existing skill covers this. Should create a new skill.
2. "update" — An existing skill partially covers this. The new pattern adds information.
   Specify which existing skill to update and what new information to add.
3. "duplicate" — An existing skill already fully covers this. Skip it.

Respond ONLY with a JSON array:
[
  {
    "pattern_name": "the-new-pattern-name",
    "verdict": "new|update|duplicate",
    "target_skill": null or "existing-skill-name",
    "reason": "one sentence explaining the verdict",
    "new_information": null or "what this pattern adds that the existing skill lacks"
  }
]
```

### Design notes:

**Why skill summaries, not full content** — Token budget. The Workflow step queries the Agent's SQL for `SELECT name, description, tags, trigger_patterns FROM skills` and formats a compact summary. Full markdown would blow the context window with 50+ skills.

**SQL integration:**

```typescript
// Inside Workflow step, via callback to Agent:
const existingSkills = agentStub.sql<SkillSummary>`
  SELECT name, description, tags, trigger_patterns FROM skills`;
```

**The "update" verdict is the most architecturally valuable** — It's where cross-session skill evolution happens. Pattern from conversation A is "partial" → crossref finds it in skills table with low completeness → verdict "update" → Prompt 3 merges evidence from both sources.

---

## PROMPT 3: DRAFT — Generate Full Skill Definition

**Runs in:** Workflow Step 4
**Triggered by:** User confirms patterns (or auto-draft for "complete" patterns)
**Called:** Once per skill to create/update

```
Generate a complete skill definition following the exact schema below.

SCHEMA (you must follow this structure precisely):
---
name: {skill_name}
description: "{one_line_description}"
tags: [{tags}]
dependencies: [{dependencies}]
version: "1.0.0"
created: "{iso_date}"
last_used: "{iso_date}"
usage_count: 0
source_conversations: [{conversation_ids}]
trigger_patterns:
  - "{pattern_1}"
  - "{pattern_2}"
---

# {Skill Title}

## Overview
[2-3 sentences: what this skill does and when to use it]

## When to Use
[Bullet list of 3-5 specific trigger scenarios — be concrete, not generic]

## Process
[Numbered step-by-step instructions. Each step must be actionable.
Do NOT write vague steps like "analyze the situation".
DO write specific steps like "List all state variables that need migration".]

## Anti-Patterns
[2-4 common mistakes this skill prevents. Format: "Do NOT [bad thing] — instead [good thing]"]

## Examples
[At least one concrete example showing input → expected behavior/output]

CONTEXT FOR THIS SKILL:

Extracted patterns:
{confirmed_patterns_json}

Source evidence from conversations:
{evidence_quotes}

{if_updating_existing}
Existing skill to update:
{existing_skill_markdown}

Merge the new information into the existing skill. Preserve everything in the
existing skill that is still valid. Add new steps, trigger patterns, or anti-patterns
from the new evidence. Increment the version number.
{end_if}

Generate the complete skill definition now. Output ONLY the skill markdown, starting with the --- frontmatter delimiter.
```

### Design notes:

**Why repeat the schema in full** — Cannot rely on Llama 3.3 memorizing the schema from the system prompt. Repeating at call time dramatically improves compliance.

**Why "Do NOT write vague steps"** — Single most important quality instruction. Without it, the model defaults to generic process descriptions. The negative + positive example forces specificity.

**SQL write on completion:**

```typescript
// Workflow step 4 writes draft to Agent SQL:
this.sql`INSERT OR REPLACE INTO skills 
  (name, description, tags, dependencies, version, created, last_used, 
   usage_count, source_conversations, trigger_patterns, content)
  VALUES (${name}, ${desc}, ${tags}, ${deps}, ${ver}, ${now}, ${now}, 
   0, ${convIds}, ${triggers}, ${fullMarkdown})`;

this.sql`INSERT OR IGNORE INTO conversation_skill_links 
  (conversation_id, skill_name) VALUES (${convId}, ${name})`;
```

---

## PROMPT 4: REFINE — Iterative Editing

**Runs in:** Agent (real-time, streaming)
**Triggered by:** User gives feedback on a drafted skill in chat
**Called:** Each time the user requests a change

```
You are refining a skill definition based on user feedback.

Current skill definition:
---
{current_skill_markdown}
---

User's feedback:
"{user_feedback}"

Rules:
- Make ONLY the changes the user requested. Do not rewrite unrelated sections.
- If the feedback is ambiguous, make your best interpretation and note what you assumed.
- If the feedback contradicts the skill schema (e.g., removing a required field), keep the field but explain why in your response.
- After making changes, output the COMPLETE updated skill definition (not a diff).
- Before the skill definition, write ONE sentence summarizing what you changed.

Output format:
[one sentence summary of changes]

[complete updated skill markdown starting with --- frontmatter]
```

### Design notes:

**Why "make ONLY the changes requested"** — Without this, Llama 3.3 "helpfully" rewrites adjacent sections. The explicit constraint prevents drift.

**Why complete definition, not diff** — (1) The Agent writes the full result to `this.sql` — no merge step needed. (2) The user sees the full result in chat for verification.

**Why one-sentence summary** — Gives the chat UI something conversational to display before the skill preview card.

**Streaming:** This prompt runs in the Agent (not Workflow), so the response is streamed back to the user via WebSocket. The one-sentence summary appears first, then the full skill renders in a preview card.

---

## PROMPT 5: SEARCH — Skill Repository Query

**Runs in:** Agent (real-time, streaming)
**Triggered by:** User asks about skills, or uses `/search [query]`
**Called:** After the Agent queries SQL for candidates

```
The user is searching their skill repository. Answer their query using ONLY the
skills provided below. Do not invent or suggest skills that are not in the repository.

User's query: "{user_query}"

Matching skills from repository:
---
{matching_skills_summary}
---

If the query is a direct lookup (e.g., "show me my React skills"), list the matching
skills with their descriptions and key metadata.

If the query is a problem-solving question (e.g., "how should I handle API errors?"),
identify which skill(s) are relevant, briefly explain why, and suggest the user
load the full skill for details.

If no skills match, say so directly and suggest the user ingest conversations
related to this topic to build a skill.
```

### Design notes:

**SQL-powered retrieval before LLM call:**

```typescript
// Inside Agent, before calling Prompt 5:
async searchSkills(connection: Connection, query: string) {
  // SQL text search as first pass
  const candidates = this.sql<SkillSummary>`
    SELECT name, description, tags, trigger_patterns, usage_count
    FROM skills
    WHERE description LIKE ${'%' + query + '%'}
       OR tags LIKE ${'%' + query + '%'}
       OR trigger_patterns LIKE ${'%' + query + '%'}
    ORDER BY usage_count DESC
    LIMIT 10`;

  if (candidates.length === 0) {
    // Fallback: return all skills for LLM to reason about
    candidates = this.sql<SkillSummary>`
      SELECT name, description, tags, trigger_patterns
      FROM skills ORDER BY usage_count DESC LIMIT 20`;
  }

  // Now call Prompt 5 with the SQL results
  await this.callLLMStreaming(connection, SYSTEM_PROMPT,
    SEARCH_PROMPT
      .replace("{user_query}", query)
      .replace("{matching_skills_summary}", JSON.stringify(candidates))
  );

  // Update usage tracking
  // (only after user explicitly loads a skill, not on search)
}
```

**"Do not invent skills"** — Critical anti-hallucination guardrail for user trust.

---

## Token Budget Planning

**IMPORTANT: Verify actual limits on Day 1.**

Check https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/ for current context window size, max output tokens, and rate limits. The estimates below are conservative starting points.

| Prompt | Where | Est. Input | Est. Output | Temperature | Strategy |
|--------|-------|-----------|-------------|-------------|----------|
| System | Both | ~200 | — | — | Always present |
| P1: Extract | Workflow | ~3500 | ~500 | 0.3 | Chunk to keep input < 3000 |
| P2: Crossref | Workflow | ~2000 | ~400 | 0.2 | Compress summaries to name+desc+tags |
| P3: Draft | Workflow | ~2500 | ~800 | 0.5 | Longest output — may need max_tokens bump |
| P4: Refine | Agent | ~1500 | ~800 | 0.3 | Stable budget, skill size bounded |
| P5: Search | Agent | ~1500 | ~300 | 0.4 | Lightest call |

**Temperature rationale:**
- P1 Extract (0.3): Consistent pattern identification
- P2 Crossref (0.2): Classification task, lowest creativity
- P3 Draft (0.5): Skill writing benefits from creativity in examples/process steps
- P4 Refine (0.3): Editing should be precise
- P5 Search (0.4): Conversational but grounded

---

## Error Handling Patterns

### LLM returns invalid JSON (Prompts 1, 2 — Workflow steps with auto-retry)

```typescript
// Inside Workflow step:
const result = await callWorkersAI(env.AI, EXTRACT_PROMPT, chunk);

let patterns;
try {
  patterns = JSON.parse(result);
  if (!Array.isArray(patterns)) throw new Error("Expected array");
  // Validate required fields per object
  for (const p of patterns) {
    if (!p.name || !p.description || !p.completeness) {
      throw new Error(`Invalid pattern: missing fields in ${JSON.stringify(p)}`);
    }
  }
} catch (e) {
  // FIXED (v2): Resend the ORIGINAL prompt with stricter suffix.
  // Do NOT append to the broken output — it could be garbage/partial.
  const retryResult = await callWorkersAI(env.AI,
    EXTRACT_PROMPT.replace("{conversation_text}", chunk)
    + "\n\nCRITICAL: Your previous response was not valid JSON. "
    + "Respond with ONLY a JSON array. No markdown, no explanation, no code fences. "
    + "Start your response with [ and end with ].",
    chunk
  );

  try {
    patterns = JSON.parse(retryResult);
  } catch (e2) {
    // If retry also fails, Workflow step throws → auto-retry at step level
    throw new Error(`Failed to parse LLM output after retry: ${retryResult.slice(0, 200)}`);
  }
}
```

**v2 fix:** The v1 approach appended "CRITICAL: respond with JSON" to the *failed output*, which could be truncated garbage. v2 resends the original prompt with a stricter suffix.

**Double retry:** First retry is in-code (re-prompt). If that fails, the Workflow step itself retries (configured with `retries: { limit: 2, backoff: "exponential" }`). This gives 3 total attempts before the user sees an error.

### LLM drafts skill missing required fields (Prompt 3)

```typescript
const requiredFrontmatter = ['name', 'description', 'tags', 'version', 'trigger_patterns'];
const requiredSections = ['Overview', 'When to Use', 'Process', 'Anti-Patterns', 'Examples'];

const missingFields = requiredFrontmatter.filter(f => !draft.frontmatter[f]);
const missingSections = requiredSections.filter(s => !draft.body.includes(`## ${s}`));

if (missingFields.length || missingSections.length) {
  // Use Prompt 4 (Refine) with synthetic feedback — don't retry the whole draft
  const fixPrompt = REFINE_PROMPT
    .replace("{current_skill_markdown}", draft.raw)
    .replace("{user_feedback}",
      `Add missing sections: ${missingSections.join(', ')}. `
      + `Add missing frontmatter fields: ${missingFields.join(', ')}.`
    );
  const fixed = await callWorkersAI(env.AI, SYSTEM_PROMPT + "\n" + fixPrompt);
  // Validate again, throw if still broken (triggers Workflow retry)
}
```

### Empty extraction (Prompt 1 returns `[]`)

```typescript
if (patterns.length === 0) {
  // Don't silently succeed — return meaningful feedback
  return {
    patterns: [],
    message: "No reusable patterns found in this conversation. "
      + "It may be too short or too narrowly focused on a single problem. "
      + "Try adding more conversations on this topic."
  };
}
```

---

## Prompt Versioning Strategy

### Sprint approach (Day 1-5): Static constants

```typescript
// src/prompts/v1.ts
export const PROMPTS = {
  system: { version: "1.0.0", template: SYSTEM_PROMPT },
  extract: { version: "1.0.0", template: EXTRACT_TEMPLATE, maxTokens: 500, temp: 0.3 },
  crossref: { version: "1.0.0", template: CROSSREF_TEMPLATE, maxTokens: 400, temp: 0.2 },
  draft: { version: "1.0.0", template: DRAFT_TEMPLATE, maxTokens: 1000, temp: 0.5 },
  refine: { version: "1.0.0", template: REFINE_TEMPLATE, maxTokens: 1000, temp: 0.3 },
  search: { version: "1.0.0", template: SEARCH_TEMPLATE, maxTokens: 400, temp: 0.4 },
} as const;
```

### Post-sprint evolution: SQL-backed runtime switching

For A/B testing or iterating on prompts without redeploying:

```typescript
// Store prompt versions in Agent's SQLite
this.sql`CREATE TABLE IF NOT EXISTS prompt_versions (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  template TEXT NOT NULL,
  max_tokens INTEGER,
  temperature REAL,
  is_active BOOLEAN DEFAULT false,
  created TEXT NOT NULL,
  PRIMARY KEY (name, version)
)`;

// Load active prompt at runtime
function getActivePrompt(name: string): PromptConfig {
  const [row] = this.sql<PromptConfig>`
    SELECT * FROM prompt_versions 
    WHERE name = ${name} AND is_active = true`;
  return row || PROMPTS[name]; // fallback to static constants
}
```

**Recommendation:** Start with static constants during the sprint. Mention the SQL-backed approach in the README as a "future direction" — it shows architectural thinking without costing implementation time.
