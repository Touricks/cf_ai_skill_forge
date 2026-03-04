# Task 2 — Day 2: Ingestion Pipeline (Claude Code Execution Plan)

> Hand this file to Claude Code. Prereq: Day 1 complete (all gate checks passed).
> Reference: prompt-skill-forge-v2.md Section 5-6, prompt-llm-internals-v2.md, day2-ingestion.test-plan.md, cloudflare-platform-guide.md

---

## Goal

Implement the full ingestion pipeline: user pastes/uploads a conversation in the Ingestion Panel, Workflow extracts patterns via LLM, Agent receives results, and the UI displays pattern cards for confirmation. By end of Day 2: paste conversation in panel -> progress bar -> pattern cards -> confirm -> draft skill.

---

## What Exists from Day 1

These files were created during Day 1 and are the starting point:

- **`src/server.ts`**: `ChatAgent extends AIChatAgent<Env>` with:
  - `onChatMessage` (streamText + tools: searchSkills, listSkills, refineSkill)
  - `onMessage` (ingestion protocol: parses JSON, routes by type, stubs for confirm/approve/delete)
  - `onStart` (creates 3 SQLite tables: skills, conversations, conversation_skill_links)
  - `handleIngest` stub (returns "not implemented yet" error)
  - Helper methods: `sendIngestion`, `loadSkillMetadata`, `computeGraphData`

- **`src/workflow.ts`**: `IngestionPipeline extends WorkflowEntrypoint<Env>` with:
  - Step 1: `chunkConversation()` implemented (splits on turn markers, groups to 2500 tokens)
  - Steps 2-4: stubs returning empty arrays (`TODO Day 2` comments)

- **`src/types.ts`**: All domain types including `ExtractedPattern`, `CrossrefVerdict`, `SkillMetadata`, `IngestionClientMessage`, `IngestionAgentMessage`, `SkillForgeState`

- **`src/prompts.ts`**: 6 prompt templates (`SYSTEM_PROMPT`, `EXTRACT_PROMPT`, `CROSSREF_PROMPT`, `DRAFT_PROMPT`, `REFINE_PROMPT`, `SEARCH_PROMPT`) + `fillTemplate()`

- **`src/app.tsx`**: Chat UI with kumo components + collapsible `IngestionPanel` component (textarea + "Start Analysis" button, sends `{ type: "ingest" }` via `agent.send()`)

- **`wrangler.jsonc`**: AI binding, ChatAgent DO, SQLite migration, Workflow binding (`INGESTION_WORKFLOW`)

---

## Step 2.1 — Improve Chunking Utility (1h)

The Day 1 `chunkConversation()` in `src/workflow.ts` is a basic implementation. Enhance it to handle edge cases from the test plan.

**Replace** the `chunkConversation` method in `src/workflow.ts`:

```typescript
private chunkConversation(text: string): string[] {
  if (!text.trim()) return [text];

  // Split on turn markers (lookahead to preserve the marker)
  const turns = text
    .split(/(?=(?:User|Human|Assistant|AI|Claude|GPT|Gemini):)/i)
    .filter((t) => t.trim().length > 0);

  // If no turn markers found, treat the whole text as one chunk
  if (turns.length === 0) return [text];

  const MAX_TOKENS = 2500;
  const chunks: string[] = [];
  let currentChunk = "";

  for (const turn of turns) {
    const combinedWords = (currentChunk + turn).split(/\s+/).length;
    const estimatedTokens = combinedWords * 1.3;

    if (estimatedTokens > MAX_TOKENS && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = turn;
    } else {
      currentChunk += turn;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Handle case where a single turn exceeds MAX_TOKENS:
  // Split oversized chunks by paragraph, or as last resort, by fixed word count
  const result: string[] = [];
  for (const chunk of chunks) {
    const tokenEstimate = chunk.split(/\s+/).length * 1.3;
    if (tokenEstimate > MAX_TOKENS * 1.5) {
      // Split by double-newline paragraphs
      const paragraphs = chunk.split(/\n\n+/).filter((p) => p.trim());
      let subChunk = "";
      for (const para of paragraphs) {
        const subTokens = (subChunk + "\n\n" + para).split(/\s+/).length * 1.3;
        if (subTokens > MAX_TOKENS && subChunk.trim()) {
          result.push(subChunk.trim());
          subChunk = para;
        } else {
          subChunk += (subChunk ? "\n\n" : "") + para;
        }
      }
      if (subChunk.trim()) result.push(subChunk.trim());
    } else {
      result.push(chunk);
    }
  }

  return result.length > 0 ? result : [text];
}
```

**Verify:** Unit-test mentally against the Day 2 test plan U2.1 and U2.2 cases (multi-turn splits, short conversations, empty input, no turn markers, oversized single turn).

---

## Step 2.2 — Workflow Step 2: Extract Patterns (2h)

This is the highest-risk step. Replace the Step 2 stub in `src/workflow.ts` with a real Workers AI call using `EXTRACT_PROMPT`.

### 2.2a — Add helper functions at the top of workflow.ts

```typescript
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { ExtractedPattern, CrossrefVerdict } from "./types";
import {
  SYSTEM_PROMPT,
  EXTRACT_PROMPT,
  CROSSREF_PROMPT,
  DRAFT_PROMPT,
  fillTemplate,
} from "./prompts";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

// ── JSON parsing with prose-stripping retry ─────────────────────
function parseJsonResponse<T>(raw: string): T {
  // Attempt 1: Direct parse
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    // pass
  }

  // Attempt 2: Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // pass
    }
  }

  // Attempt 3: Find first [ or { and parse from there
  const arrayStart = raw.indexOf("[");
  const objStart = raw.indexOf("{");
  const start = arrayStart >= 0 && (objStart < 0 || arrayStart < objStart)
    ? arrayStart
    : objStart;

  if (start >= 0) {
    const bracket = raw[start];
    const closeBracket = bracket === "[" ? "]" : "}";
    const lastClose = raw.lastIndexOf(closeBracket);
    if (lastClose > start) {
      try {
        return JSON.parse(raw.slice(start, lastClose + 1)) as T;
      } catch {
        // pass
      }
    }
  }

  throw new Error(`Failed to parse JSON from LLM response: ${raw.slice(0, 200)}`);
}

// ── Pattern validation ──────────────────────────────────────────
const VALID_COMPLETENESS = new Set(["complete", "partial", "fragment"]);

function validatePatterns(patterns: unknown[]): ExtractedPattern[] {
  const valid: ExtractedPattern[] = [];
  for (const p of patterns) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;

    // Required fields
    if (typeof obj.name !== "string" || !obj.name) continue;
    if (typeof obj.description !== "string" || !obj.description) continue;
    if (!Array.isArray(obj.evidence)) continue;
    if (typeof obj.completeness !== "string" || !VALID_COMPLETENESS.has(obj.completeness)) continue;
    if (!Array.isArray(obj.tags)) continue;

    valid.push({
      name: obj.name,
      description: obj.description,
      evidence: obj.evidence.map(String),
      completeness: obj.completeness as ExtractedPattern["completeness"],
      tags: obj.tags.map(String),
    });
  }
  return valid;
}

// ── Verdict validation ──────────────────────────────────────────
const VALID_VERDICTS = new Set(["new", "update", "duplicate"]);

function validateVerdicts(verdicts: unknown[]): CrossrefVerdict[] {
  const valid: CrossrefVerdict[] = [];
  for (const v of verdicts) {
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;

    if (typeof obj.pattern_name !== "string" || !obj.pattern_name) continue;
    if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict)) continue;
    if (typeof obj.reason !== "string") continue;

    valid.push({
      pattern_name: obj.pattern_name,
      verdict: obj.verdict as CrossrefVerdict["verdict"],
      target_skill: typeof obj.target_skill === "string" ? obj.target_skill : null,
      reason: obj.reason,
      new_information: typeof obj.new_information === "string" ? obj.new_information : null,
    });
  }
  return valid;
}

// ── Deduplication by name similarity ────────────────────────────
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function deduplicatePatterns(patterns: ExtractedPattern[]): ExtractedPattern[] {
  const COMPLETENESS_RANK: Record<string, number> = {
    complete: 3,
    partial: 2,
    fragment: 1,
  };

  const result: ExtractedPattern[] = [];
  const used = new Set<number>();

  for (let i = 0; i < patterns.length; i++) {
    if (used.has(i)) continue;

    let best = patterns[i];

    for (let j = i + 1; j < patterns.length; j++) {
      if (used.has(j)) continue;
      const dist = levenshtein(patterns[i].name, patterns[j].name);
      if (dist < 3 || patterns[i].name === patterns[j].name) {
        used.add(j);
        // Keep the more complete pattern
        const rankBest = COMPLETENESS_RANK[best.completeness] || 0;
        const rankJ = COMPLETENESS_RANK[patterns[j].completeness] || 0;
        if (rankJ > rankBest) {
          best = {
            ...patterns[j],
            evidence: [...best.evidence, ...patterns[j].evidence],
            tags: [...new Set([...best.tags, ...patterns[j].tags])],
          };
        } else {
          best = {
            ...best,
            evidence: [...best.evidence, ...patterns[j].evidence],
            tags: [...new Set([...best.tags, ...patterns[j].tags])],
          };
        }
      }
    }

    result.push(best);
  }

  return result;
}
```

### 2.2b — Replace Step 2 in the `run()` method

```typescript
// Step 2: Extract patterns — Prompt 1 (per chunk)
const patterns = await step.do(
  "extract-patterns",
  { retries: { limit: 2, backoff: "exponential" } },
  async () => {
    const allPatterns: ExtractedPattern[] = [];

    for (const chunk of chunks) {
      const prompt = fillTemplate(EXTRACT_PROMPT, {
        conversation_text: chunk,
      });

      const response = await this.env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      });

      const raw = typeof response === "string"
        ? response
        : (response as { response?: string }).response || "";

      let parsed: unknown[];
      try {
        parsed = parseJsonResponse<unknown[]>(raw);
      } catch {
        // Retry with stricter instruction
        const retryResponse = await this.env.AI.run(MODEL, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: prompt +
                "\n\nCRITICAL: Your previous response was not valid JSON. " +
                "Respond with ONLY a JSON array. No markdown, no explanation, no code fences. " +
                "Start your response with [ and end with ].",
            },
          ],
          max_tokens: 1000,
          temperature: 0.2,
        });

        const retryRaw = typeof retryResponse === "string"
          ? retryResponse
          : (retryResponse as { response?: string }).response || "";

        parsed = parseJsonResponse<unknown[]>(retryRaw);
      }

      if (!Array.isArray(parsed)) {
        throw new Error(`Expected array from LLM, got: ${typeof parsed}`);
      }

      const validated = validatePatterns(parsed);
      allPatterns.push(...validated);
    }

    if (allPatterns.length === 0) {
      return {
        patterns: [] as ExtractedPattern[],
        message:
          "No reusable patterns found in this conversation. " +
          "It may be too short or too narrowly focused on a single problem. " +
          "Try adding more conversations on this topic.",
      };
    }

    return {
      patterns: deduplicatePatterns(allPatterns),
      message: null,
    };
  }
);
```

### Adaptation Notes

**Workers AI response shape:** The return type from `this.env.AI.run()` for text-generation models is `{ response: string }`. Always extract `.response`. Handle both string and object cases defensively since the type signature may vary.

**JSON retry pattern:** The first attempt parses the raw response with `parseJsonResponse` which tries direct parse, then strips code fences, then finds the outermost JSON structure. If all three fail, a retry prompt is sent with `CRITICAL: respond with ONLY a JSON array`. If the retry also fails, the error propagates to Workflow step-level retry (configured with `retries: { limit: 2, backoff: "exponential" }`). This gives 6 total attempts (2 in-code x 3 step-level).

**Temperature:** Extract uses 0.3 for first attempt, 0.2 for retry (lower creativity = more compliant formatting).

---

## Step 2.3 — Workflow Step 3: Crossref Against Existing Skills (1.5h)

Replace the Step 3 stub. This step reads existing skills from the Agent's SQL (via a Workflow-accessible mechanism) and calls Prompt 2 (CROSSREF).

### The challenge: Workflow cannot access Agent's `this.sql`

Workflows run as separate `WorkflowEntrypoint` instances. They do **not** have access to the Agent's embedded SQLite. Two options:

1. **Pass existing skills in the Workflow payload** (simpler, chosen approach)
2. Use Durable Object RPC to query the Agent (complex, not needed for MVP)

**Modify** the Workflow event payload to include existing skills. In `src/types.ts`, add a type for the workflow params:

```typescript
// Add to src/types.ts
export interface IngestionWorkflowParams {
  conversationText: string;
  agentId: string;
  existingSkills: Array<{
    name: string;
    description: string;
    tags: string;
    trigger_patterns: string;
  }>;
}
```

**Update** the `run()` method signature:

```typescript
async run(
  event: WorkflowEvent<IngestionWorkflowParams>,
  step: WorkflowStep
) {
  const { conversationText, agentId, existingSkills } = event.payload;
  // ... rest of pipeline
```

**Replace Step 3:**

```typescript
// Step 3: Crossref existing skills — Prompt 2 (batch)
const verdicts = await step.do(
  "crossref-skills",
  { retries: { limit: 2, backoff: "exponential" } },
  async () => {
    const extractedPatterns = patterns.patterns;

    // If no patterns were extracted, skip crossref
    if (extractedPatterns.length === 0) {
      return [] as CrossrefVerdict[];
    }

    // If no existing skills, all patterns are "new"
    if (existingSkills.length === 0) {
      return extractedPatterns.map((p) => ({
        pattern_name: p.name,
        verdict: "new" as const,
        target_skill: null,
        reason: "No existing skills in repository.",
        new_information: null,
      }));
    }

    // Format existing skills for the prompt
    const existingSkillsSummary = existingSkills
      .map(
        (s) =>
          `- name: ${s.name}\n  description: ${s.description}\n  tags: ${s.tags}\n  trigger_patterns: ${s.trigger_patterns}`
      )
      .join("\n");

    const prompt = fillTemplate(CROSSREF_PROMPT, {
      existing_skills_summary: existingSkillsSummary,
      new_patterns_json: JSON.stringify(extractedPatterns, null, 2),
    });

    const response = await this.env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 800,
      temperature: 0.2,
    });

    const raw = typeof response === "string"
      ? response
      : (response as { response?: string }).response || "";

    let parsed: unknown[];
    try {
      parsed = parseJsonResponse<unknown[]>(raw);
    } catch {
      // Retry with stricter instruction
      const retryResponse = await this.env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: prompt +
              "\n\nCRITICAL: Your previous response was not valid JSON. " +
              "Respond with ONLY a JSON array. No markdown, no explanation. " +
              "Start your response with [ and end with ].",
          },
        ],
        max_tokens: 800,
        temperature: 0.1,
      });

      const retryRaw = typeof retryResponse === "string"
        ? retryResponse
        : (retryResponse as { response?: string }).response || "";

      parsed = parseJsonResponse<unknown[]>(retryRaw);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Expected array from crossref, got: ${typeof parsed}`);
    }

    return validateVerdicts(parsed);
  }
);
```

---

## Step 2.4 — Workflow Step 4: Draft Skills (1.5h)

Replace the Step 4 stub. Only draft skills for patterns with verdict "new" or "update". For "update", include the existing skill content in the prompt.

**Expand** the Workflow payload to include existing skill content for "update" verdicts. Add to `IngestionWorkflowParams`:

```typescript
export interface IngestionWorkflowParams {
  conversationText: string;
  agentId: string;
  existingSkills: Array<{
    name: string;
    description: string;
    tags: string;
    trigger_patterns: string;
  }>;
  existingSkillContent: Record<string, string>; // name -> full markdown content
}
```

**Replace Step 4:**

```typescript
// Step 4: Draft skills — Prompt 3 (per confirmed new/update pattern)
const drafts = await step.do(
  "draft-skills",
  { retries: { limit: 2, backoff: "exponential" } },
  async () => {
    const extractedPatterns = patterns.patterns;
    if (extractedPatterns.length === 0) return [] as string[];

    // Filter to patterns that need drafting (new or update)
    const toDraft = verdicts.filter(
      (v) => v.verdict === "new" || v.verdict === "update"
    );

    if (toDraft.length === 0) return [] as string[];

    const results: string[] = [];
    const now = new Date().toISOString();

    for (const verdict of toDraft) {
      // Find the matching extracted pattern for evidence
      const pattern = extractedPatterns.find(
        (p) => p.name === verdict.pattern_name
      );
      if (!pattern) continue;

      // Build the prompt with template variables
      const isUpdate = verdict.verdict === "update" && verdict.target_skill;
      const existingContent = isUpdate
        ? event.payload.existingSkillContent[verdict.target_skill!] || ""
        : "";

      const templateVars: Record<string, string> = {
        skill_name: pattern.name,
        one_line_description: pattern.description,
        tags: pattern.tags.map((t) => `"${t}"`).join(", "),
        dependencies: "[]",
        iso_date: now,
        conversation_ids: `"${agentId}"`,
        confirmed_patterns_json: JSON.stringify([pattern], null, 2),
        evidence_quotes: pattern.evidence.join("\n\n"),
      };

      // Handle update vs new
      let promptText = fillTemplate(DRAFT_PROMPT, templateVars);

      if (isUpdate && existingContent) {
        // Replace the conditional block markers with actual content
        promptText = promptText
          .replace("{if_updating_existing}", "")
          .replace("{existing_skill_markdown}", existingContent)
          .replace("{end_if}", "");
      } else {
        // Remove the update block entirely
        const ifStart = promptText.indexOf("{if_updating_existing}");
        const ifEnd = promptText.indexOf("{end_if}");
        if (ifStart >= 0 && ifEnd >= 0) {
          promptText =
            promptText.slice(0, ifStart) +
            promptText.slice(ifEnd + "{end_if}".length);
        }
      }

      const response = await this.env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: promptText },
        ],
        max_tokens: 1500,
        temperature: 0.5,
      });

      const raw = typeof response === "string"
        ? response
        : (response as { response?: string }).response || "";

      results.push(raw);
    }

    return results;
  }
);
```

### Update the return value

```typescript
return {
  chunks: chunks.length,
  patterns: patterns.patterns,
  patternsMessage: patterns.message,
  verdicts,
  drafts,
};
```

---

## Step 2.5 — Add IngestionAgentMessage types for progress (10min)

**Update** `src/types.ts` to add the `ingestion_progress` message type (referenced in prompt-skill-forge-v2.md Section 5):

```typescript
// Agent -> Client (via connection.send / this.broadcast)
export type IngestionAgentMessage =
  | { type: "ingestion_started"; workflowId: string }
  | { type: "ingestion_progress"; step: string; pct: number }
  | { type: "patterns_extracted"; patterns: ExtractedPattern[] }
  | { type: "skill_drafted"; markdown: string }
  | { type: "error"; message: string };
```

---

## Step 2.6 — Agent <-> Workflow Integration (1h)

Replace the `handleIngest` stub and add `confirm_patterns` and `approve` handlers in `src/server.ts`.

### 2.6a — Replace handleIngest

```typescript
private async handleIngest(
  connection: Connection,
  content: string
): Promise<void> {
  if (!content.trim() || content.trim().length < 50) {
    this.sendIngestion(connection, {
      type: "error",
      message:
        "Conversation text is too short. Please paste a longer AI conversation (at least a few exchanges).",
    });
    return;
  }

  // Store conversation in SQL
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();

  this.sql.exec(
    `INSERT INTO conversations (id, title, ingested_at, raw_text)
     VALUES (?, ?, ?, ?)`,
    conversationId,
    "Imported conversation",
    now,
    content
  );

  // Load existing skills for crossref
  const existingSkillRows = this.sql
    .exec(
      `SELECT name, description, tags, trigger_patterns, content
       FROM skills`
    )
    .toArray();

  const existingSkills = existingSkillRows.map((r: any) => ({
    name: r.name as string,
    description: r.description as string,
    tags: r.tags as string,
    trigger_patterns: r.trigger_patterns as string,
  }));

  const existingSkillContent: Record<string, string> = {};
  for (const row of existingSkillRows) {
    existingSkillContent[(row as any).name] = (row as any).content;
  }

  // Trigger Workflow
  try {
    const instance = await this.env.INGESTION_WORKFLOW.create({
      params: {
        conversationText: content,
        agentId: conversationId,
        existingSkills,
        existingSkillContent,
      },
    });

    this.sendIngestion(connection, {
      type: "ingestion_started",
      workflowId: instance.id,
    });

    // Update state to show "running" in the UI
    this.setState({
      ...this.state,
      ingestionStatus: "running",
    });

    // Poll for completion (Workflows are async — no callback mechanism)
    this.pollWorkflow(connection, instance, conversationId);
  } catch (err) {
    this.sendIngestion(connection, {
      type: "error",
      message: `Failed to start ingestion pipeline: ${err instanceof Error ? err.message : String(err)}`,
    });
    this.setState({
      ...this.state,
      ingestionStatus: "error",
    });
  }
}
```

### 2.6b — Add pollWorkflow method

Cloudflare Workflows are asynchronous. The Agent cannot `await` a Workflow run. Use polling to check completion.

```typescript
private async pollWorkflow(
  connection: Connection,
  instance: { id: string; status: () => Promise<{ status: string; output?: unknown }> },
  conversationId: string
): Promise<void> {
  const MAX_POLLS = 60; // 5 minutes max (60 * 5s)
  const POLL_INTERVAL = 5000; // 5 seconds

  const steps = ["chunking", "extracting patterns", "cross-referencing", "drafting skills"];
  let stepIndex = 0;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    try {
      const status = await instance.status();

      // Simulate progress based on polling iteration
      if (stepIndex < steps.length) {
        this.sendIngestion(connection, {
          type: "ingestion_progress",
          step: steps[Math.min(stepIndex, steps.length - 1)],
          pct: Math.min(((i + 1) / 20) * 100, 95),
        });
        // Advance step estimate every ~4 polls
        if (i > 0 && i % 4 === 0 && stepIndex < steps.length - 1) {
          stepIndex++;
        }
      }

      if (status.status === "complete") {
        this.handleWorkflowComplete(connection, status.output, conversationId);
        return;
      }

      if (status.status === "errored") {
        this.sendIngestion(connection, {
          type: "error",
          message: "Ingestion pipeline failed. Please try again.",
        });
        this.setState({ ...this.state, ingestionStatus: "error" });
        return;
      }

      // status === "running" -> keep polling
    } catch (err) {
      console.error("Poll error:", err);
      // Continue polling on transient errors
    }
  }

  // Timeout
  this.sendIngestion(connection, {
    type: "error",
    message: "Ingestion pipeline timed out after 5 minutes.",
  });
  this.setState({ ...this.state, ingestionStatus: "error" });
}
```

### 2.6c — Add handleWorkflowComplete method

```typescript
private handleWorkflowComplete(
  connection: Connection,
  output: unknown,
  conversationId: string
): void {
  const result = output as {
    chunks: number;
    patterns: ExtractedPattern[];
    patternsMessage: string | null;
    verdicts: CrossrefVerdict[];
    drafts: string[];
  };

  if (!result.patterns || result.patterns.length === 0) {
    this.sendIngestion(connection, {
      type: "error",
      message:
        result.patternsMessage ||
        "No patterns found in this conversation.",
    });
    this.setState({
      ...this.state,
      ingestionStatus: "complete",
      pendingPatterns: [],
    });
    return;
  }

  // Store extracted patterns in the conversation record
  this.sql.exec(
    `UPDATE conversations SET extracted_patterns = ? WHERE id = ?`,
    JSON.stringify(result.patterns),
    conversationId
  );

  // Send patterns to the client for review
  this.sendIngestion(connection, {
    type: "patterns_extracted",
    patterns: result.patterns,
  });

  // If there are drafts, send the first one
  if (result.drafts.length > 0) {
    this.sendIngestion(connection, {
      type: "skill_drafted",
      markdown: result.drafts[0],
    });
  }

  // Update state
  this.setState({
    ...this.state,
    ingestionStatus: "complete",
    pendingPatterns: result.patterns,
    draftSkill: result.drafts.length > 0 ? result.drafts[0] : null,
  });

  // Send 100% progress
  this.sendIngestion(connection, {
    type: "ingestion_progress",
    step: "complete",
    pct: 100,
  });
}
```

### 2.6d — Implement confirm_patterns handler

Replace the stub in `onMessage`:

```typescript
case "confirm_patterns": {
  const confirmed = parsed.patterns;
  if (!confirmed || confirmed.length === 0) {
    this.sendIngestion(connection, {
      type: "error",
      message: "No patterns selected for confirmation.",
    });
    return;
  }
  // For now, the draft was already generated in the pipeline.
  // In a more advanced version, re-drafting with only confirmed patterns
  // could happen here. For MVP, the patterns are stored as-is.
  this.sendIngestion(connection, {
    type: "skill_drafted",
    markdown: this.state.draftSkill || "No draft available. Try ingesting again.",
  });
  return;
}
```

### 2.6e — Implement approve handler

```typescript
case "approve": {
  const skillName = parsed.skillName;
  const draftMarkdown = this.state.draftSkill;
  if (!draftMarkdown) {
    this.sendIngestion(connection, {
      type: "error",
      message: "No draft skill to approve.",
    });
    return;
  }

  // Parse frontmatter from the draft to extract metadata
  const now = new Date().toISOString();
  const tags = this.state.pendingPatterns
    .flatMap((p) => p.tags)
    .filter((v, i, a) => a.indexOf(v) === i);

  this.sql.exec(
    `INSERT OR REPLACE INTO skills
       (name, description, tags, dependencies, version, created, last_used,
        usage_count, source_conversations, trigger_patterns, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    skillName,
    this.state.pendingPatterns[0]?.description || skillName,
    JSON.stringify(tags),
    "[]",
    "1.0.0",
    now,
    now,
    0,
    "[]",
    JSON.stringify(this.state.pendingPatterns.flatMap((p) => [p.name])),
    draftMarkdown
  );

  // Update state: clear pending, refresh skills list
  const skills = this.loadSkillMetadata();
  const graphData = this.computeGraphData(skills);

  this.setState({
    ...this.state,
    skills,
    graphData,
    pendingPatterns: [],
    draftSkill: null,
    ingestionStatus: "idle",
  });

  this.sendIngestion(connection, {
    type: "skill_drafted",
    markdown: `Skill "${skillName}" saved successfully.`,
  });
  return;
}
```

### 2.6f — Import the state initialization

Make sure `ChatAgent` has an `initialState` and initializes the state properly. Add to `onStart`:

```typescript
onStart(): void {
  // SQL schema
  this.sql.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]',
      version TEXT NOT NULL DEFAULT '1.0.0',
      created TEXT NOT NULL,
      last_used TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      source_conversations TEXT NOT NULL DEFAULT '[]',
      trigger_patterns TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      ingested_at TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      extracted_patterns TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_skill_links (
      conversation_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      PRIMARY KEY (conversation_id, skill_name)
    );
  `);

  // Initialize state if not already set
  if (!this.state || !this.state.ingestionStatus) {
    const skills = this.loadSkillMetadata();
    const graphData = this.computeGraphData(skills);
    this.setState({
      skills,
      graphData,
      draftSkill: null,
      pendingPatterns: [],
      ingestionStatus: "idle",
    });
  }
}
```

### Adaptation Notes

**Workflow polling:** Cloudflare Workflows do not have a built-in callback mechanism to the Agent. The recommended approach is polling `instance.status()`. The `pollWorkflow` method polls every 5 seconds for up to 5 minutes. The Workflow instance reference is obtained from `INGESTION_WORKFLOW.create()`.

**Workflow instance API:** The return value of `INGESTION_WORKFLOW.create()` has:
- `.id` — unique workflow instance ID
- `.status()` — returns `{ status: "running" | "complete" | "errored", output?: unknown }`
- `.abort()` — cancel the workflow

**setState:** `this.setState()` on the Agent automatically syncs the state object to all connected clients via the `useAgent` hook on the frontend. This is how the Ingestion Panel receives status updates.

**Existing skills in payload:** Passing existing skills in the Workflow payload is simpler than cross-DO RPC but has a payload size limit. For MVP (< 100 skills), this is fine. For production scale, switch to Durable Object RPC via `this.env.ChatAgent.get(id)`.

---

## Step 2.7 — Ingestion Panel UI: Progress + File Upload (1.5h)

Enhance the existing `IngestionPanel` component in `src/app.tsx` with:
1. File drag-and-drop upload
2. Progress bar showing pipeline steps
3. Error display

**Replace** the `IngestionPanel` component:

```tsx
// ── Ingestion Panel ────────────────────────────────────────────────

type IngestionStatus = "idle" | "running" | "complete" | "error";

interface IngestionProgress {
  step: string;
  pct: number;
}

function IngestionPanel({
  agent,
  status,
  progress,
  error,
  patterns,
  draftSkill,
  onPatternsConfirmed,
}: {
  agent: ReturnType<typeof useAgent>;
  status: IngestionStatus;
  progress: IngestionProgress | null;
  error: string | null;
  patterns: ExtractedPattern[];
  draftSkill: string | null;
  onPatternsConfirmed: () => void;
}) {
  const [content, setContent] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-open when patterns arrive
  useEffect(() => {
    if (patterns.length > 0 || status === "running") {
      setIsOpen(true);
    }
  }, [patterns, status]);

  const handleIngest = () => {
    if (!content.trim()) return;
    agent.send(JSON.stringify({ type: "ingest", content: content.trim() }));
    setContent("");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        if (text) setContent(text);
      };
      reader.readAsText(files[0]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        if (text) setContent(text);
      };
      reader.readAsText(files[0]);
    }
  };

  if (!isOpen) {
    return (
      <div className="px-5 pt-4">
        <Button variant="outline" size="sm" onClick={() => setIsOpen(true)}>
          + Ingest Conversation
        </Button>
      </div>
    );
  }

  return (
    <div className="px-5 pt-4">
      <Surface className="p-4 rounded-xl ring ring-kumo-line">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <Text size="sm" bold>
            Ingest Conversation
          </Text>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            onClick={() => setIsOpen(false)}
          >
            <XIcon size={14} />
          </Button>
        </div>

        {/* Input area with drag-and-drop */}
        {status === "idle" && patterns.length === 0 && (
          <>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`relative ${isDragging ? "ring-2 ring-kumo-accent rounded-lg" : ""}`}
            >
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste an AI conversation here, or drag and drop a file..."
                rows={6}
                className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive font-mono resize-y"
              />
              {isDragging && (
                <div className="absolute inset-0 flex items-center justify-center bg-kumo-base/80 rounded-lg">
                  <Text size="sm" variant="secondary">
                    Drop file here
                  </Text>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleIngest}
                disabled={!content.trim()}
              >
                Start Analysis
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.json"
                onChange={handleFileSelect}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload File
              </Button>
            </div>
          </>
        )}

        {/* Progress bar */}
        {status === "running" && progress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Text size="xs" variant="secondary">
                {progress.step}...
              </Text>
              <Text size="xs" variant="secondary">
                {Math.round(progress.pct)}%
              </Text>
            </div>
            <div className="w-full h-2 bg-kumo-control rounded-full overflow-hidden">
              <div
                className="h-full bg-kumo-accent rounded-full transition-all duration-500"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
            <Text size="xs" className="text-red-400">
              {error}
            </Text>
          </div>
        )}

        {/* Pattern cards */}
        {patterns.length > 0 && <PatternCards patterns={patterns} agent={agent} onConfirmed={onPatternsConfirmed} />}

        {/* Draft preview */}
        {draftSkill && status === "complete" && patterns.length === 0 && (
          <div className="mt-3">
            <Text size="xs" variant="secondary" bold className="mb-2">
              Draft Skill
            </Text>
            <div className="max-h-60 overflow-y-auto rounded-lg bg-kumo-base p-3 border border-kumo-line">
              <Streamdown className="sd-theme" controls={false} isAnimating={false}>
                {draftSkill}
              </Streamdown>
            </div>
          </div>
        )}
      </Surface>
    </div>
  );
}
```

---

## Step 2.8 — Pattern Cards Component (1h)

Add a `PatternCards` component that renders each `ExtractedPattern` with confirm/reject controls.

```tsx
// ── Pattern Cards ──────────────────────────────────────────────────

function PatternCards({
  patterns,
  agent,
  onConfirmed,
}: {
  patterns: ExtractedPattern[];
  agent: ReturnType<typeof useAgent>;
  onConfirmed: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(patterns.map((p) => p.name))
  );

  const togglePattern = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const confirmed = patterns.filter((p) => selected.has(p.name));
    agent.send(
      JSON.stringify({ type: "confirm_patterns", patterns: confirmed })
    );
    onConfirmed();
  };

  const completenessColor: Record<string, string> = {
    complete: "text-kumo-success",
    partial: "text-kumo-warning",
    fragment: "text-kumo-danger",
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center justify-between">
        <Text size="xs" variant="secondary" bold>
          Extracted Patterns ({patterns.length})
        </Text>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={selected.size === 0}
          >
            Confirm {selected.size} Pattern{selected.size !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>

      <div className="space-y-2 max-h-80 overflow-y-auto">
        {patterns.map((pattern) => {
          const isSelected = selected.has(pattern.name);
          return (
            <div
              key={pattern.name}
              onClick={() => togglePattern(pattern.name)}
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                isSelected
                  ? "border-kumo-accent bg-kumo-accent/5"
                  : "border-kumo-line bg-kumo-base opacity-60"
              }`}
            >
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      isSelected
                        ? "bg-kumo-accent border-kumo-accent"
                        : "border-kumo-line"
                    }`}
                  >
                    {isSelected && (
                      <CheckCircleIcon size={12} className="text-white" />
                    )}
                  </div>
                  <Text size="sm" bold>
                    {pattern.name}
                  </Text>
                </div>
                <span
                  className={`text-xs font-medium ${completenessColor[pattern.completeness] || ""}`}
                >
                  {pattern.completeness}
                </span>
              </div>

              <Text size="xs" variant="secondary" className="ml-6 mb-2">
                {pattern.description}
              </Text>

              <div className="flex flex-wrap gap-1 ml-6">
                {pattern.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>

              {pattern.evidence.length > 0 && (
                <div className="mt-2 ml-6">
                  <Text size="xs" variant="secondary" className="italic">
                    Evidence: "{pattern.evidence[0].slice(0, 100)}
                    {pattern.evidence[0].length > 100 ? "..." : ""}"
                  </Text>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## Step 2.9 — Wire Up the Chat Component to Handle Ingestion Messages (30min)

Update the `Chat` component in `src/app.tsx` to:
1. Track ingestion state from `onMessage` events
2. Pass state to `IngestionPanel`
3. Import the `ExtractedPattern` type

### Update the onMessage handler and state in Chat

Add state variables and update the `useAgent` `onMessage` callback:

```tsx
function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toasts = useKumoToastManager();

  // Ingestion state
  const [ingestionStatus, setIngestionStatus] = useState<IngestionStatus>("idle");
  const [ingestionProgress, setIngestionProgress] = useState<IngestionProgress | null>(null);
  const [ingestionError, setIngestionError] = useState<string | null>(null);
  const [pendingPatterns, setPendingPatterns] = useState<ExtractedPattern[]>([]);
  const [draftSkill, setDraftSkill] = useState<string | null>(null);

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));

          switch (data.type) {
            case "ingestion_started":
              setIngestionStatus("running");
              setIngestionError(null);
              setIngestionProgress({ step: "starting", pct: 0 });
              break;
            case "ingestion_progress":
              setIngestionProgress({ step: data.step, pct: data.pct });
              break;
            case "patterns_extracted":
              setPendingPatterns(data.patterns || []);
              setIngestionStatus("complete");
              setIngestionProgress(null);
              break;
            case "skill_drafted":
              setDraftSkill(data.markdown);
              break;
            case "error":
              setIngestionError(data.message);
              if (ingestionStatus === "running") {
                setIngestionStatus("error");
              }
              setIngestionProgress(null);
              break;
            case "scheduled-task":
              toasts.add({
                title: "Scheduled task completed",
                description: data.description,
                timeout: 0,
              });
              break;
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [toasts]
    ),
  });

  // ... (rest of Chat component stays the same)

  // In the JSX, add IngestionPanel before the messages area:
  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header (unchanged) */}
      <header>...</header>

      {/* Ingestion Panel */}
      <IngestionPanel
        agent={agent}
        status={ingestionStatus}
        progress={ingestionProgress}
        error={ingestionError}
        patterns={pendingPatterns}
        draftSkill={draftSkill}
        onPatternsConfirmed={() => {
          setPendingPatterns([]);
        }}
      />

      {/* Messages (unchanged) */}
      <div className="flex-1 overflow-y-auto">...</div>

      {/* Input (unchanged) */}
      <div className="border-t border-kumo-line bg-kumo-base">...</div>
    </div>
  );
}
```

### Import the type at the top of app.tsx

```typescript
import type { ExtractedPattern } from "./types";
```

### Remove MCP-related code

Since Day 1 removes MCP support, ensure the MCP state variables, `handleAddServer`, `handleRemoveServer`, and the MCP panel JSX are removed from the Chat component. Keep only the ingestion + chat functionality.

---

## Step 2.10 — Error Handling Polish (30min)

### In workflow.ts: Wrap the entire `run()` method

```typescript
async run(
  event: WorkflowEvent<IngestionWorkflowParams>,
  step: WorkflowStep
) {
  const { conversationText, agentId, existingSkills } = event.payload;

  // Step 1: Chunk conversation (non-LLM, no retry needed)
  const chunks = await step.do("chunk-conversation", async () => {
    return this.chunkConversation(conversationText);
  });

  // Step 2: Extract patterns
  const patterns = await step.do(
    "extract-patterns",
    { retries: { limit: 2, backoff: "exponential" } },
    async () => {
      // ... (as defined in Step 2.2b)
    }
  );

  // Step 3: Crossref
  const verdicts = await step.do(
    "crossref-skills",
    { retries: { limit: 2, backoff: "exponential" } },
    async () => {
      // ... (as defined in Step 2.3)
    }
  );

  // Step 4: Draft
  const drafts = await step.do(
    "draft-skills",
    { retries: { limit: 2, backoff: "exponential" } },
    async () => {
      // ... (as defined in Step 2.4)
    }
  );

  return {
    chunks: chunks.length,
    patterns: patterns.patterns,
    patternsMessage: patterns.message,
    verdicts,
    drafts,
  };
}
```

### In server.ts: Validate inbound messages defensively

The `onMessage` handler already has a try/catch for JSON parsing. Add type guards:

```typescript
async onMessage(connection: Connection, message: string): Promise<void> {
  // Ignore non-string or empty messages
  if (typeof message !== "string" || !message.trim()) return;

  let parsed: IngestionClientMessage;
  try {
    parsed = JSON.parse(message) as IngestionClientMessage;
  } catch {
    // Might be a framework-internal message — ignore silently
    return;
  }

  // Type guard: must have a 'type' field
  if (!parsed || typeof parsed.type !== "string") return;

  switch (parsed.type) {
    case "ingest":
      if (typeof parsed.content !== "string") {
        this.sendIngestion(connection, {
          type: "error",
          message: "Invalid ingest payload: content must be a string.",
        });
        return;
      }
      return this.handleIngest(connection, parsed.content);

    case "confirm_patterns":
      // ... (as defined in Step 2.6d)

    case "approve":
      // ... (as defined in Step 2.6e)

    case "delete_skill":
      this.sendIngestion(connection, {
        type: "error",
        message: "delete_skill not implemented yet. Coming Day 3.",
      });
      return;

    default:
      // Unknown message type — ignore (may be framework message)
      break;
  }
}
```

---

## Full File Reference: src/workflow.ts

For clarity, here is the complete `src/workflow.ts` after all Day 2 changes:

```typescript
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type {
  ExtractedPattern,
  CrossrefVerdict,
  IngestionWorkflowParams,
} from "./types";
import {
  SYSTEM_PROMPT,
  EXTRACT_PROMPT,
  CROSSREF_PROMPT,
  DRAFT_PROMPT,
  fillTemplate,
} from "./prompts";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

// ── JSON parsing with prose-stripping retry ─────────────────────
function parseJsonResponse<T>(raw: string): T {
  // Attempt 1: Direct parse
  try {
    return JSON.parse(raw) as T;
  } catch {
    // pass
  }

  // Attempt 2: Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // pass
    }
  }

  // Attempt 3: Find first [ or { and parse from there
  const arrayStart = raw.indexOf("[");
  const objStart = raw.indexOf("{");
  const start =
    arrayStart >= 0 && (objStart < 0 || arrayStart < objStart)
      ? arrayStart
      : objStart;

  if (start >= 0) {
    const bracket = raw[start];
    const closeBracket = bracket === "[" ? "]" : "}";
    const lastClose = raw.lastIndexOf(closeBracket);
    if (lastClose > start) {
      try {
        return JSON.parse(raw.slice(start, lastClose + 1)) as T;
      } catch {
        // pass
      }
    }
  }

  throw new Error(
    `Failed to parse JSON from LLM response: ${raw.slice(0, 200)}`
  );
}

// ── Validation helpers ──────────────────────────────────────────
const VALID_COMPLETENESS = new Set(["complete", "partial", "fragment"]);
const VALID_VERDICTS = new Set(["new", "update", "duplicate"]);

function validatePatterns(patterns: unknown[]): ExtractedPattern[] {
  const valid: ExtractedPattern[] = [];
  for (const p of patterns) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    if (typeof obj.name !== "string" || !obj.name) continue;
    if (typeof obj.description !== "string" || !obj.description) continue;
    if (!Array.isArray(obj.evidence)) continue;
    if (
      typeof obj.completeness !== "string" ||
      !VALID_COMPLETENESS.has(obj.completeness)
    )
      continue;
    if (!Array.isArray(obj.tags)) continue;

    valid.push({
      name: obj.name,
      description: obj.description,
      evidence: obj.evidence.map(String),
      completeness: obj.completeness as ExtractedPattern["completeness"],
      tags: obj.tags.map(String),
    });
  }
  return valid;
}

function validateVerdicts(verdicts: unknown[]): CrossrefVerdict[] {
  const valid: CrossrefVerdict[] = [];
  for (const v of verdicts) {
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    if (typeof obj.pattern_name !== "string" || !obj.pattern_name) continue;
    if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict))
      continue;
    if (typeof obj.reason !== "string") continue;

    valid.push({
      pattern_name: obj.pattern_name,
      verdict: obj.verdict as CrossrefVerdict["verdict"],
      target_skill:
        typeof obj.target_skill === "string" ? obj.target_skill : null,
      reason: obj.reason,
      new_information:
        typeof obj.new_information === "string" ? obj.new_information : null,
    });
  }
  return valid;
}

// ── Deduplication ───────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function deduplicatePatterns(
  patterns: ExtractedPattern[]
): ExtractedPattern[] {
  const RANK: Record<string, number> = {
    complete: 3,
    partial: 2,
    fragment: 1,
  };
  const result: ExtractedPattern[] = [];
  const used = new Set<number>();

  for (let i = 0; i < patterns.length; i++) {
    if (used.has(i)) continue;
    let best = patterns[i];

    for (let j = i + 1; j < patterns.length; j++) {
      if (used.has(j)) continue;
      if (
        levenshtein(patterns[i].name, patterns[j].name) < 3 ||
        patterns[i].name === patterns[j].name
      ) {
        used.add(j);
        const rankBest = RANK[best.completeness] || 0;
        const rankJ = RANK[patterns[j].completeness] || 0;
        if (rankJ > rankBest) {
          best = {
            ...patterns[j],
            evidence: [...best.evidence, ...patterns[j].evidence],
            tags: [...new Set([...best.tags, ...patterns[j].tags])],
          };
        } else {
          best = {
            ...best,
            evidence: [...best.evidence, ...patterns[j].evidence],
            tags: [...new Set([...best.tags, ...patterns[j].tags])],
          };
        }
      }
    }

    result.push(best);
  }

  return result;
}

// ── Workflow ─────────────────────────────────────────────────────
export class IngestionPipeline extends WorkflowEntrypoint<Env> {
  async run(
    event: WorkflowEvent<IngestionWorkflowParams>,
    step: WorkflowStep
  ) {
    const { conversationText, agentId, existingSkills } = event.payload;

    // Step 1: Chunk conversation (non-LLM)
    const chunks = await step.do("chunk-conversation", async () => {
      return this.chunkConversation(conversationText);
    });

    // Step 2: Extract patterns — Prompt 1 (per chunk)
    const patterns = await step.do(
      "extract-patterns",
      { retries: { limit: 2, backoff: "exponential" } },
      async () => {
        const allPatterns: ExtractedPattern[] = [];

        for (const chunk of chunks) {
          const prompt = fillTemplate(EXTRACT_PROMPT, {
            conversation_text: chunk,
          });

          const response = await this.env.AI.run(MODEL, {
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            max_tokens: 1000,
            temperature: 0.3,
          });

          const raw =
            typeof response === "string"
              ? response
              : (response as { response?: string }).response || "";

          let parsed: unknown[];
          try {
            parsed = parseJsonResponse<unknown[]>(raw);
          } catch {
            // Retry with stricter instruction
            const retryResponse = await this.env.AI.run(MODEL, {
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                {
                  role: "user",
                  content:
                    prompt +
                    "\n\nCRITICAL: Your previous response was not valid JSON. " +
                    "Respond with ONLY a JSON array. No markdown, no explanation, no code fences. " +
                    "Start your response with [ and end with ].",
                },
              ],
              max_tokens: 1000,
              temperature: 0.2,
            });

            const retryRaw =
              typeof retryResponse === "string"
                ? retryResponse
                : (retryResponse as { response?: string }).response || "";

            parsed = parseJsonResponse<unknown[]>(retryRaw);
          }

          if (!Array.isArray(parsed)) {
            throw new Error(`Expected array from LLM, got: ${typeof parsed}`);
          }

          allPatterns.push(...validatePatterns(parsed));
        }

        if (allPatterns.length === 0) {
          return {
            patterns: [] as ExtractedPattern[],
            message:
              "No reusable patterns found in this conversation. " +
              "It may be too short or too narrowly focused on a single problem. " +
              "Try adding more conversations on this topic.",
          };
        }

        return {
          patterns: deduplicatePatterns(allPatterns),
          message: null,
        };
      }
    );

    // Step 3: Crossref existing skills — Prompt 2 (batch)
    const verdicts = await step.do(
      "crossref-skills",
      { retries: { limit: 2, backoff: "exponential" } },
      async () => {
        const extractedPatterns = patterns.patterns;

        if (extractedPatterns.length === 0) {
          return [] as CrossrefVerdict[];
        }

        if (existingSkills.length === 0) {
          return extractedPatterns.map((p) => ({
            pattern_name: p.name,
            verdict: "new" as const,
            target_skill: null,
            reason: "No existing skills in repository.",
            new_information: null,
          }));
        }

        const existingSkillsSummary = existingSkills
          .map(
            (s) =>
              `- name: ${s.name}\n  description: ${s.description}\n  tags: ${s.tags}\n  trigger_patterns: ${s.trigger_patterns}`
          )
          .join("\n");

        const prompt = fillTemplate(CROSSREF_PROMPT, {
          existing_skills_summary: existingSkillsSummary,
          new_patterns_json: JSON.stringify(extractedPatterns, null, 2),
        });

        const response = await this.env.AI.run(MODEL, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: 800,
          temperature: 0.2,
        });

        const raw =
          typeof response === "string"
            ? response
            : (response as { response?: string }).response || "";

        let parsed: unknown[];
        try {
          parsed = parseJsonResponse<unknown[]>(raw);
        } catch {
          const retryResponse = await this.env.AI.run(MODEL, {
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content:
                  prompt +
                  "\n\nCRITICAL: Your previous response was not valid JSON. " +
                  "Respond with ONLY a JSON array. No markdown, no explanation. " +
                  "Start your response with [ and end with ].",
              },
            ],
            max_tokens: 800,
            temperature: 0.1,
          });

          const retryRaw =
            typeof retryResponse === "string"
              ? retryResponse
              : (retryResponse as { response?: string }).response || "";

          parsed = parseJsonResponse<unknown[]>(retryRaw);
        }

        if (!Array.isArray(parsed)) {
          throw new Error(`Expected array from crossref, got: ${typeof parsed}`);
        }

        return validateVerdicts(parsed);
      }
    );

    // Step 4: Draft skills — Prompt 3 (per new/update pattern)
    const drafts = await step.do(
      "draft-skills",
      { retries: { limit: 2, backoff: "exponential" } },
      async () => {
        const extractedPatterns = patterns.patterns;
        if (extractedPatterns.length === 0) return [] as string[];

        const toDraft = verdicts.filter(
          (v) => v.verdict === "new" || v.verdict === "update"
        );
        if (toDraft.length === 0) return [] as string[];

        const results: string[] = [];
        const now = new Date().toISOString();

        for (const verdict of toDraft) {
          const pattern = extractedPatterns.find(
            (p) => p.name === verdict.pattern_name
          );
          if (!pattern) continue;

          const isUpdate =
            verdict.verdict === "update" && verdict.target_skill;
          const existingContent = isUpdate
            ? event.payload.existingSkillContent?.[verdict.target_skill!] || ""
            : "";

          const templateVars: Record<string, string> = {
            skill_name: pattern.name,
            one_line_description: pattern.description,
            tags: pattern.tags.map((t) => `"${t}"`).join(", "),
            dependencies: "[]",
            iso_date: now,
            conversation_ids: `"${agentId}"`,
            confirmed_patterns_json: JSON.stringify([pattern], null, 2),
            evidence_quotes: pattern.evidence.join("\n\n"),
          };

          let promptText = fillTemplate(DRAFT_PROMPT, templateVars);

          if (isUpdate && existingContent) {
            promptText = promptText
              .replace("{if_updating_existing}", "")
              .replace("{existing_skill_markdown}", existingContent)
              .replace("{end_if}", "");
          } else {
            const ifStart = promptText.indexOf("{if_updating_existing}");
            const ifEnd = promptText.indexOf("{end_if}");
            if (ifStart >= 0 && ifEnd >= 0) {
              promptText =
                promptText.slice(0, ifStart) +
                promptText.slice(ifEnd + "{end_if}".length);
            }
          }

          const response = await this.env.AI.run(MODEL, {
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: promptText },
            ],
            max_tokens: 1500,
            temperature: 0.5,
          });

          const raw =
            typeof response === "string"
              ? response
              : (response as { response?: string }).response || "";

          results.push(raw);
        }

        return results;
      }
    );

    return {
      chunks: chunks.length,
      patterns: patterns.patterns,
      patternsMessage: patterns.message,
      verdicts,
      drafts,
    };
  }

  private chunkConversation(text: string): string[] {
    if (!text.trim()) return [text];

    const turns = text
      .split(/(?=(?:User|Human|Assistant|AI|Claude|GPT|Gemini):)/i)
      .filter((t) => t.trim().length > 0);

    if (turns.length === 0) return [text];

    const MAX_TOKENS = 2500;
    const chunks: string[] = [];
    let currentChunk = "";

    for (const turn of turns) {
      const combinedWords = (currentChunk + turn).split(/\s+/).length;
      const estimatedTokens = combinedWords * 1.3;

      if (estimatedTokens > MAX_TOKENS && currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = turn;
      } else {
        currentChunk += turn;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    const result: string[] = [];
    for (const chunk of chunks) {
      const tokenEstimate = chunk.split(/\s+/).length * 1.3;
      if (tokenEstimate > MAX_TOKENS * 1.5) {
        const paragraphs = chunk.split(/\n\n+/).filter((p) => p.trim());
        let subChunk = "";
        for (const para of paragraphs) {
          const subTokens =
            (subChunk + "\n\n" + para).split(/\s+/).length * 1.3;
          if (subTokens > MAX_TOKENS && subChunk.trim()) {
            result.push(subChunk.trim());
            subChunk = para;
          } else {
            subChunk += (subChunk ? "\n\n" : "") + para;
          }
        }
        if (subChunk.trim()) result.push(subChunk.trim());
      } else {
        result.push(chunk);
      }
    }

    return result.length > 0 ? result : [text];
  }
}
```

---

## Smoke Test (30min)

```bash
cd agents-starter
npm run dev
# Opens at http://localhost:5173
```

### Test Checklist

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | `npm run dev` starts | No build errors |
| 2 | Ingestion panel renders | Collapsible panel with textarea, "Start Analysis" button |
| 3 | Paste short text (< 50 chars), click "Start Analysis" | Error: "too short" in ingestion panel, NOT in chat |
| 4 | Paste a real multi-turn AI conversation (~1000 words) | Progress bar appears: "chunking" -> "extracting patterns" -> ... |
| 5 | Pipeline completes | Pattern cards appear with names, descriptions, tags, completeness badges |
| 6 | Click confirm on patterns | "skill_drafted" message received, draft preview shown |
| 7 | Chat "hello" while ingestion runs | Chat responds normally, ingestion continues independently |
| 8 | Drag-drop a .txt file onto the panel | File content loads into textarea |
| 9 | Click "Upload File" button | File picker opens, selected file loads into textarea |
| 10 | `npm run check` passes | oxfmt + oxlint + tsc all pass |

### Test Conversation (paste this for testing)

Use this multi-turn conversation for end-to-end testing. It contains two identifiable skill patterns (React state migration strategy and API error handling).

```text
Human: I'm trying to migrate a React class component with complex state to hooks. The component uses this.state with nested objects and multiple lifecycle methods. Where do I start?
Assistant: For migrating a complex class component to hooks, here is a systematic approach:

1. Inventory your state: List every piece of this.state. Group related fields that always update together.
2. Map lifecycle methods: componentDidMount becomes useEffect with empty deps array. componentDidUpdate becomes useEffect with specific deps. componentWillUnmount becomes the cleanup return function in useEffect.
3. Choose state strategy: Simple values use individual useState hooks. Nested objects that update together should use useReducer to avoid stale closure bugs.
4. Do not try to do it all at once. Start by converting one lifecycle method at a time.

Human: That makes sense. What about API error handling? I have a lot of try/catch blocks and the error handling is inconsistent across my app.

Assistant: Inconsistent error handling is one of the most common codebase problems. Here is a pattern I recommend:

1. Create a centralized error handler class that categorizes errors (network, auth, validation, unknown).
2. Each category gets a standard response: network errors trigger retry with exponential backoff, auth errors redirect to login, validation errors show inline field messages.
3. Wrap your API client (axios/fetch) with an interceptor that routes through this handler.
4. Components only handle the happy path. Errors bubble up to error boundaries or the centralized handler.

The key insight: error handling should be declarative at the component level and imperative only at the infrastructure level.
```

**Expected patterns**: The LLM should extract at least:
- `react-state-migration` (complete) -- systematic lifecycle-to-hooks conversion
- `api-error-handling-strategy` (complete) -- centralized error categorization pattern

---

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `AI binding not found` | Missing AI config in wrangler.jsonc | Verify `"ai": { "binding": "AI", "remote": true }` |
| `INGESTION_WORKFLOW is not defined` | Missing workflow binding | Verify `"workflows"` array in wrangler.jsonc |
| Workers AI 429 rate limit | Too many LLM calls | Add delay between chunk calls, or wait for UTC midnight reset |
| Workers AI returns empty string | Model overloaded or prompt too long | Check prompt token count, reduce chunk size |
| JSON parse fails after retry | LLM consistently wrapping in prose | Check `parseJsonResponse` handles all wrapper formats (code fences, prose prefix, etc.) |
| Workflow times out | LLM calls taking too long per step | Reduce max_tokens, use fewer chunks, check model availability |
| `this.sql is not a function` | Missing SQLite migration in wrangler.jsonc | Verify `new_sqlite_classes` includes `ChatAgent` |
| Workflow status stuck on `running` | Workflow step hanging | Check Workers AI dashboard for errors; increase poll timeout |
| Patterns empty for valid conversation | EXTRACT_PROMPT too strict or conversation too short | Lower temperature, check fillTemplate output, try with longer test conversation |
| State not updating in UI | `setState` not called or state shape mismatch | Verify `this.setState()` is called in `handleWorkflowComplete`; check `SkillForgeState` type matches |
| `useAgent` onMessage not firing | Message format mismatch | Verify Agent sends JSON with `connection.send(JSON.stringify(...))` |
| Drag-and-drop not working | Missing event handlers or file type filter | Check `onDragOver` calls `e.preventDefault()`, check `accept` attribute on file input |

---

## Day 2 Definition of Done

- [ ] `chunkConversation()` handles normal + edge cases (multi-turn splits, short text, no markers, oversized turns)
- [ ] Workflow Step 2 (Extract) calls Workers AI with EXTRACT_PROMPT and returns validated `ExtractedPattern[]`
- [ ] Workflow Step 3 (Crossref) compares patterns against existing skills, returns `CrossrefVerdict[]`
- [ ] Workflow Step 4 (Draft) generates skill markdown for new/update patterns
- [ ] Full Workflow pipeline executes all 4 steps in sequence and returns results
- [ ] JSON retry pattern works: parse failure -> stricter re-prompt -> step-level retry
- [ ] Agent `handleIngest` triggers Workflow, stores conversation in SQL, polls for results
- [ ] Agent receives Workflow results and updates state (pendingPatterns, ingestionStatus, draftSkill)
- [ ] `confirm_patterns` and `approve` message handlers are implemented
- [ ] Ingestion Panel shows progress bar during pipeline execution
- [ ] Pattern cards render with name, description, tags, completeness badge, select/deselect
- [ ] Confirm button sends selected patterns to Agent
- [ ] File drag-and-drop and upload button load file content into textarea
- [ ] Errors display in the Ingestion Panel (not in chat)
- [ ] Chat works independently while ingestion runs
- [ ] `npm run check` passes (oxfmt + oxlint + tsc)

**All items must pass. See `docs/test/day2-ingestion.test-plan.md` for detailed acceptance criteria.**

**-> Ready for Day 3: Refinement Loop + Skill CRUD**
