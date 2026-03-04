# Task 3 — Day 3: Refinement Loop + Skill CRUD (Claude Code Execution Plan)

> Hand this file to Claude Code. Prereq: Day 1 + Day 2 complete — Agent with `onChatMessage` (tools: searchSkills, listSkills, refineSkill), `onMessage` (ingestion protocol), 3 SQLite tables, working ingestion pipeline (paste -> extract -> patterns -> draft).
> Reference: prompt-llm-internals-v2.md (Prompts 4-5), test/day3-refinement.test-plan.md, prompt-skill-forge-v2.md (Section 5 UI)

---

## Goal

Complete the skill lifecycle: refine drafted skills interactively in chat, save approved skills to SQLite, enable CRUD operations, add LLM-powered search, wire slash commands from frontend, and add a skill preview panel.

---

## Step 3.1 — Enhanced `refineSkill` Tool with LLM Call (1.5h)

The `refineSkill` tool stub from Day 1 loads the skill content and returns it to the LLM context. Enhance it to actually call the REFINE_PROMPT template and produce an updated skill definition.

**Architecture reminder:** `refineSkill` is a `tool()` definition inside `onChatMessage`'s `streamText()` call. The user types natural feedback in chat (e.g., "Add error handling to the Process section"), the LLM decides to invoke `refineSkill`, and the tool returns the refined content. The LLM then presents the result conversationally.

### 3.1a — Add `REFINE_PROMPT` helper in `src/server.ts`

The refine operation needs a secondary LLM call *inside* the tool's `execute` function. Since `streamText()` is already running (it's what invoked the tool), the inner call must be a non-streaming `env.AI.run()` call.

```typescript
// Add to imports in src/server.ts
import { REFINE_PROMPT, SEARCH_PROMPT, fillTemplate } from "./prompts";

// Add private method to ChatAgent class
private async callRefine(
  currentMarkdown: string,
  feedback: string
): Promise<string> {
  const prompt = fillTemplate(REFINE_PROMPT, {
    current_skill_markdown: currentMarkdown,
    user_feedback: feedback,
  });

  const response = await this.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as BaseAiTextGenerationModels,
    {
      messages: [
        { role: "system", content: "You are Skill Forge, a developer skill architect." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.3,
    }
  );

  // Workers AI returns { response: string } for text generation
  const text = typeof response === "string"
    ? response
    : (response as any).response ?? "";
  return text;
}
```

**Why `env.AI.run()` instead of nested `streamText()`:** You cannot nest `streamText()` calls — the outer call is already streaming to the client. The tool's `execute` function runs server-side and returns a result synchronously (from the tool's perspective). Use the raw Workers AI binding for this inner call.

### 3.1b — Enhance the `refineSkill` tool

Replace the Day 1 stub with the full implementation:

```typescript
refineSkill: tool({
  description:
    "Refine an existing skill based on user feedback. Use when the user wants to edit, improve, or change a skill definition.",
  inputSchema: z.object({
    skillName: z.string().describe("Name of the skill to refine"),
    feedback: z.string().describe("User's specific feedback for what to change"),
  }),
  execute: async ({ skillName, feedback }) => {
    // 1. Try loading from state.draftSkill first (active draft being refined)
    let currentContent: string | null = null;
    const state = this.getState();

    if (
      state?.draftSkill &&
      state.draftSkill.includes(`name: ${skillName}`)
    ) {
      currentContent = state.draftSkill;
    }

    // 2. Fallback: load from SQLite (saved skill being re-refined)
    if (!currentContent) {
      const rows = this.sql
        .exec("SELECT content FROM skills WHERE name = ?", skillName)
        .toArray();
      if (rows.length > 0) {
        currentContent = (rows[0] as any).content;
      }
    }

    if (!currentContent) {
      return {
        error: `Skill "${skillName}" not found in drafts or repository.`,
        suggestion: "Check the skill name with /skills or refine the current draft.",
      };
    }

    // 3. Call LLM with REFINE_PROMPT
    const refined = await this.callRefine(currentContent, feedback);

    // 4. Update state.draftSkill with the refined version
    this.setState({
      ...state,
      draftSkill: refined,
    });

    // 5. Return context for the outer LLM to present conversationally
    return {
      refinedSkill: refined,
      instruction:
        "Present the one-sentence change summary from the refined output. " +
        "Tell the user they can provide more feedback to keep refining, " +
        "or approve the skill when satisfied.",
    };
  },
}),
```

### 3.1c — Handle draft skill name extraction

When refining a draft that hasn't been saved yet, the user might not know the exact kebab-case name. Add a helper:

```typescript
// Add private method to ChatAgent class
private extractSkillName(markdown: string): string | null {
  const match = markdown.match(/^name:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}
```

This lets the LLM resolve "refine the current draft" by extracting the name from `state.draftSkill`.

### Adaptation Notes

- The `refineSkill` tool returns data to the *outer* `streamText()` call. The LLM then uses this data to compose a conversational response. The tool itself does NOT stream to the client.
- `this.getState()` and `this.setState()` are inherited from the Agent base class. They manage the `SkillForgeState` synced to the frontend via `useAgent`.
- If `env.AI.run()` requires a type assertion for the model name, use `as BaseAiTextGenerationModels` from `@cloudflare/workers-types` or cast as `any`.

---

## Step 3.2 — Skill Save on Approve (1h)

The `approve` message type is handled in `onMessage` (ingestion channel), NOT as a chat tool. The user clicks "Approve" in the ingestion panel or skill preview card.

### 3.2a — Frontmatter parser utility

Create `src/utils.ts` with a parser that extracts YAML frontmatter from the skill markdown:

```typescript
// src/utils.ts
import type { SkillMetadata } from "./types";

/**
 * Parse YAML-like frontmatter from a skill markdown document.
 * Expects format:
 * ---
 * name: skill-name
 * description: "..."
 * tags: [tag1, tag2]
 * ...
 * ---
 * # Skill Title
 * ...
 */
export function parseSkillFrontmatter(
  markdown: string
): { metadata: Partial<SkillMetadata>; body: string } | null {
  const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = markdown.match(fmRegex);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2];
  const metadata: Record<string, any> = {};

  for (const line of frontmatter.split("\n")) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    let value: any = rawValue.trim();

    // Parse JSON arrays: [tag1, tag2] or ["tag1", "tag2"]
    if (value.startsWith("[") && value.endsWith("]")) {
      try {
        value = JSON.parse(value);
      } catch {
        // Try parsing as bare-word list: [tag1, tag2] -> ["tag1", "tag2"]
        value = value
          .slice(1, -1)
          .split(",")
          .map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    }
    // Strip surrounding quotes from strings
    else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Parse numbers
    else if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }

    metadata[key] = value;
  }

  // Parse YAML-style list items for trigger_patterns (multi-line)
  const triggerBlock = frontmatter.match(
    /trigger_patterns:\s*\n((?:\s+-\s+"[^"]*"\s*\n?)+)/
  );
  if (triggerBlock) {
    metadata.trigger_patterns = triggerBlock[1]
      .split("\n")
      .map((line: string) => {
        const m = line.match(/^\s+-\s+"(.+)"$/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
  }

  return {
    metadata: metadata as Partial<SkillMetadata>,
    body,
  };
}

/**
 * Validate that all required frontmatter fields are present.
 * Returns list of missing field names, or empty array if valid.
 */
export function validateSkillMetadata(
  metadata: Partial<SkillMetadata>
): string[] {
  const required: (keyof SkillMetadata)[] = [
    "name",
    "description",
    "tags",
    "version",
  ];
  return required.filter((field) => {
    const val = metadata[field];
    return val === undefined || val === null || val === "";
  });
}
```

### 3.2b — Implement `approve` handler in `onMessage`

In `src/server.ts`, replace the Day 1 stub for the `approve` case:

```typescript
case "approve": {
  const state = this.getState() as SkillForgeState | null;
  const draft = state?.draftSkill;

  if (!draft) {
    this.sendIngestion(connection, {
      type: "error",
      message: "No draft skill to approve.",
    });
    return;
  }

  // 1. Parse frontmatter from draft markdown
  const parsed = parseSkillFrontmatter(draft);
  if (!parsed) {
    this.sendIngestion(connection, {
      type: "error",
      message: "Draft skill has invalid format — missing frontmatter delimiters (---).",
    });
    return;
  }

  const { metadata } = parsed;
  const missing = validateSkillMetadata(metadata);
  if (missing.length > 0) {
    this.sendIngestion(connection, {
      type: "error",
      message: `Draft skill missing required fields: ${missing.join(", ")}. Refine it first.`,
    });
    return;
  }

  const now = new Date().toISOString();
  const name = metadata.name!;
  const description = metadata.description!;
  const tags = JSON.stringify(metadata.tags ?? []);
  const dependencies = JSON.stringify(metadata.dependencies ?? []);
  const version = metadata.version ?? "1.0.0";
  const created = metadata.created ?? now;
  const last_used = now;
  const usage_count = metadata.usage_count ?? 0;
  const source_conversations = JSON.stringify(metadata.source_conversations ?? []);
  const trigger_patterns = JSON.stringify(metadata.trigger_patterns ?? []);

  // 2. INSERT OR REPLACE into skills table
  this.sql.exec(
    `INSERT OR REPLACE INTO skills
      (name, description, tags, dependencies, version, created,
       last_used, usage_count, source_conversations, trigger_patterns, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name,
    description,
    tags,
    dependencies,
    version,
    created,
    last_used,
    usage_count,
    source_conversations,
    trigger_patterns,
    draft
  );

  // 3. Link to source conversations (if any)
  const convIds: string[] = metadata.source_conversations ?? [];
  for (const convId of convIds) {
    this.sql.exec(
      `INSERT OR IGNORE INTO conversation_skill_links (conversation_id, skill_name)
       VALUES (?, ?)`,
      convId,
      name
    );
  }

  // 4. Update state: add to skills list, clear draft, recompute graph
  const skills = this.loadSkillMetadata();
  const graphData = this.computeGraphData(skills);

  this.setState({
    ...state,
    skills,
    graphData,
    draftSkill: null,
    pendingPatterns: [],
    ingestionStatus: "idle" as const,
  });

  // 5. Notify client
  this.sendIngestion(connection, {
    type: "skill_saved",
    skillName: name,
  } as any);

  return;
}
```

### 3.2c — Add `skill_saved` to `IngestionAgentMessage`

Update `src/types.ts` to include the new message type:

```typescript
// Add to IngestionAgentMessage union:
| { type: "skill_saved"; skillName: string }
```

### Adaptation Notes

- `parseSkillFrontmatter` is deliberately permissive — the LLM may produce slight formatting variations. The parser handles `[tag1, tag2]` (no quotes), `["tag1", "tag2"]` (quoted), and YAML-style `- "item"` lists.
- `INSERT OR REPLACE` allows re-saving a refined skill without a separate update path. The skill name is the primary key.
- `this.loadSkillMetadata()` and `this.computeGraphData()` already exist from Day 1. They reload all skills from SQLite and recompute the graph.

---

## Step 3.3 — Skill CRUD: List, View, Update, Delete (1.5h)

### 3.3a — Enhance `listSkills` tool

Replace the Day 1 stub to return full metadata:

```typescript
listSkills: tool({
  description:
    "List all skills in the user's repository with metadata. Use when the user asks about their skills, types /skills, or wants an overview.",
  inputSchema: z.object({}),
  execute: async () => {
    const rows = this.sql
      .exec(
        `SELECT name, description, tags, version, usage_count,
                created, last_used, trigger_patterns
         FROM skills
         ORDER BY last_used DESC`
      )
      .toArray();

    if (rows.length === 0) {
      return {
        skills: [],
        message:
          "No skills in repository yet. Paste a conversation in the Ingestion Panel to get started.",
      };
    }

    return {
      skills: rows.map((r: any) => ({
        name: r.name,
        description: r.description,
        tags: JSON.parse(r.tags),
        version: r.version,
        usageCount: r.usage_count,
        created: r.created,
        lastUsed: r.last_used,
        triggerPatterns: JSON.parse(r.trigger_patterns),
      })),
      count: rows.length,
    };
  },
}),
```

### 3.3b — Add `viewSkill` tool

Add a new tool for viewing a single skill in full:

```typescript
viewSkill: tool({
  description:
    "View the full content of a specific skill by name. Use when the user asks to see, show, or open a skill.",
  inputSchema: z.object({
    skillName: z.string().describe("The kebab-case name of the skill to view"),
  }),
  execute: async ({ skillName }) => {
    const rows = this.sql
      .exec(
        "SELECT content, usage_count, last_used FROM skills WHERE name = ?",
        skillName
      )
      .toArray();

    if (rows.length === 0) {
      return { error: `Skill "${skillName}" not found.` };
    }

    const row = rows[0] as any;

    // Bump usage_count and last_used
    this.sql.exec(
      "UPDATE skills SET usage_count = usage_count + 1, last_used = ? WHERE name = ?",
      new Date().toISOString(),
      skillName
    );

    return {
      content: row.content,
      usageCount: row.usage_count + 1,
      lastUsed: new Date().toISOString(),
    };
  },
}),
```

### 3.3c — Implement `delete_skill` handler in `onMessage`

Replace the Day 1 stub for the `delete_skill` case:

```typescript
case "delete_skill": {
  const { skillName } = parsed as { type: "delete_skill"; skillName: string };

  // Check if skill exists
  const existing = this.sql
    .exec("SELECT name FROM skills WHERE name = ?", skillName)
    .toArray();

  if (existing.length === 0) {
    this.sendIngestion(connection, {
      type: "error",
      message: `Skill "${skillName}" not found.`,
    });
    return;
  }

  // Delete skill and its conversation links
  this.sql.exec("DELETE FROM skills WHERE name = ?", skillName);
  this.sql.exec(
    "DELETE FROM conversation_skill_links WHERE skill_name = ?",
    skillName
  );

  // Update state
  const state = this.getState() as SkillForgeState | null;
  const skills = this.loadSkillMetadata();
  const graphData = this.computeGraphData(skills);

  this.setState({
    ...(state ?? {}),
    skills,
    graphData,
  } as SkillForgeState);

  this.sendIngestion(connection, {
    type: "skill_deleted",
    skillName,
  } as any);

  return;
}
```

### 3.3d — Add `skill_deleted` to `IngestionAgentMessage`

```typescript
// Add to IngestionAgentMessage union in src/types.ts:
| { type: "skill_deleted"; skillName: string }
```

### Adaptation Notes

- **Update flow:** Updating an existing skill is done by refining it (tool `refineSkill`) then approving again. `INSERT OR REPLACE` in the approve handler handles the overwrite. No separate "update" message type needed.
- **Delete is an ingestion channel message**, not a chat tool, because it's a destructive action triggered by a UI button (not conversational intent).
- The `viewSkill` tool bumps `usage_count` on every view. This feeds into graph node sizing (Day 4).

---

## Step 3.4 — Enhanced `searchSkills` with SQL Pre-filter + LLM Summary (1.5h)

### 3.4a — Add LLM search helper

```typescript
// Add private method to ChatAgent class
private async callSearch(
  query: string,
  matchingSkills: any[]
): Promise<string> {
  const prompt = fillTemplate(SEARCH_PROMPT, {
    user_query: query,
    matching_skills_summary: JSON.stringify(matchingSkills, null, 2),
  });

  const response = await this.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as BaseAiTextGenerationModels,
    {
      messages: [
        { role: "system", content: "You are Skill Forge, a developer skill architect." },
        { role: "user", content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.4,
    }
  );

  const text = typeof response === "string"
    ? response
    : (response as any).response ?? "";
  return text;
}
```

### 3.4b — Replace `searchSkills` tool

```typescript
searchSkills: tool({
  description:
    "Search the user's skill repository by query. Use when the user asks about specific skills, wants to find a skill, or types /search.",
  inputSchema: z.object({
    query: z.string().describe("Search query — keyword, topic, or question"),
  }),
  execute: async ({ query }) => {
    // 1. SQL text search as first pass (name, description, tags, trigger_patterns)
    let rows = this.sql
      .exec(
        `SELECT name, description, tags, trigger_patterns, usage_count
         FROM skills
         WHERE name LIKE ? OR description LIKE ?
            OR tags LIKE ? OR trigger_patterns LIKE ?
         ORDER BY usage_count DESC
         LIMIT 10`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`
      )
      .toArray();

    // 2. Fallback: return top skills by usage for LLM to reason about
    if (rows.length === 0) {
      rows = this.sql
        .exec(
          `SELECT name, description, tags, trigger_patterns, usage_count
           FROM skills
           ORDER BY usage_count DESC
           LIMIT 20`
        )
        .toArray();
    }

    // 3. If still no skills at all, short-circuit
    if (rows.length === 0) {
      return {
        results: [],
        message:
          "No skills in repository yet. Ingest some conversations to build your skill library.",
      };
    }

    // 4. Parse JSON fields for clean presentation
    const candidates = rows.map((r: any) => ({
      name: r.name,
      description: r.description,
      tags: JSON.parse(r.tags),
      triggerPatterns: JSON.parse(r.trigger_patterns),
      usageCount: r.usage_count,
    }));

    // 5. Call SEARCH_PROMPT for LLM-generated conversational answer
    const llmAnswer = await this.callSearch(query, candidates);

    return {
      results: candidates,
      answer: llmAnswer,
      instruction:
        "Present the LLM answer to the user. It references specific skills by name.",
    };
  },
}),
```

### Adaptation Notes

- Like `refineSkill`, the inner LLM call uses `env.AI.run()` (not `streamText()`).
- The SQL `LIKE` search is deliberately simple. For the sprint, this is sufficient. Post-sprint, this could be upgraded to FTS5 or vector search.
- The fallback (return top skills) ensures the LLM can always give a useful response, even if the query doesn't match exact SQL text.
- The tool returns both raw `results` (for potential UI rendering) and the `answer` (LLM narrative). The outer `streamText()` LLM uses the `answer` to compose its chat response.

---

## Step 3.5 — Slash Commands: /ingest, /search, /skills, /skill [name] (1h)

Commands are parsed on the **frontend** in `src/app.tsx`. They intercept the chat input before it reaches `useAgentChat.sendMessage()` and route to the appropriate channel.

### 3.5a — Command parser utility

Add to `src/utils.ts` (or create `src/commands.ts`):

```typescript
// src/commands.ts

export interface ParsedCommand {
  type: "ingest" | "search" | "list_skills" | "view_skill" | "chat";
  content?: string;   // raw text after the command
  skillName?: string;  // for /skill [name]
}

/**
 * Parse slash commands from chat input.
 * Returns { type: "chat" } for non-command input (pass to useAgentChat).
 */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  // Not a command — regular chat
  if (!trimmed.startsWith("/")) {
    return { type: "chat", content: trimmed };
  }

  const spaceIndex = trimmed.indexOf(" ");
  const command = spaceIndex === -1
    ? trimmed.toLowerCase()
    : trimmed.slice(0, spaceIndex).toLowerCase();
  const rest = spaceIndex === -1
    ? ""
    : trimmed.slice(spaceIndex + 1).trim();

  switch (command) {
    case "/ingest":
      return { type: "ingest", content: rest || undefined };

    case "/search":
      return { type: "search", content: rest || undefined };

    case "/skills":
    case "/skill-list":
      return { type: "list_skills" };

    case "/skill":
      return { type: "view_skill", skillName: rest || undefined };

    default:
      // Unknown command — show help hint via chat
      return {
        type: "chat",
        content: `Unknown command "${command}". Available: /ingest, /search, /skills, /skill [name]`,
      };
  }
}

/**
 * List of available commands for autocomplete/hint UI.
 */
export const COMMAND_HINTS = [
  { command: "/ingest", description: "Paste a conversation for skill extraction" },
  { command: "/search", description: "Search your skill repository", arg: "query" },
  { command: "/skills", description: "List all skills in your repository" },
  { command: "/skill", description: "View a specific skill", arg: "name" },
] as const;
```

### 3.5b — Wire commands in `src/app.tsx`

Modify the chat input submission handler. The existing `useAgentChat.sendMessage()` handles regular chat. Commands either (a) route to the ingestion channel via `useAgent.send()`, or (b) inject a specific message into the chat to trigger the right tool.

```tsx
// Inside the Chat component in app.tsx
import { parseCommand, COMMAND_HINTS } from "./commands";

// In the submit handler (wherever sendMessage is called):
const handleSubmit = (inputText: string) => {
  const parsed = parseCommand(inputText);

  switch (parsed.type) {
    case "ingest":
      // Route to ingestion channel
      if (parsed.content) {
        agent.send(JSON.stringify({ type: "ingest", content: parsed.content }));
      } else {
        // Open ingestion panel if no content provided
        setIngestionOpen(true);
      }
      break;

    case "search":
      // Send as chat message — the LLM will invoke searchSkills tool
      sendMessage({
        role: "user",
        parts: [
          { type: "text", text: `Search my skills for: ${parsed.content ?? ""}` },
        ],
      });
      break;

    case "list_skills":
      // Send as chat message — the LLM will invoke listSkills tool
      sendMessage({
        role: "user",
        parts: [
          { type: "text", text: "List all my skills with their metadata." },
        ],
      });
      break;

    case "view_skill":
      // Send as chat message — the LLM will invoke viewSkill tool
      sendMessage({
        role: "user",
        parts: [
          {
            type: "text",
            text: parsed.skillName
              ? `Show me the full content of the skill "${parsed.skillName}".`
              : "Which skill would you like me to show?",
          },
        ],
      });
      break;

    case "chat":
    default:
      // Regular chat message
      sendMessage({
        role: "user",
        parts: [{ type: "text", text: parsed.content ?? inputText }],
      });
      break;
  }
};
```

### 3.5c — Command hint dropdown (optional, but useful)

Show a hint dropdown when the user types `/` in the chat input:

```tsx
// Inside Chat component, near the InputArea
const [showHints, setShowHints] = useState(false);
const [inputValue, setInputValue] = useState("");

// Watch for "/" prefix
useEffect(() => {
  setShowHints(inputValue.startsWith("/") && inputValue.length < 10);
}, [inputValue]);

// Render hint dropdown above the input
{showHints && (
  <div className="absolute bottom-full left-0 right-0 mb-1 bg-kumo-elevated border border-kumo-line rounded-lg shadow-lg overflow-hidden z-10">
    {COMMAND_HINTS.filter((h) =>
      h.command.startsWith(inputValue.split(" ")[0])
    ).map((hint) => (
      <button
        key={hint.command}
        className="w-full text-left px-3 py-2 text-sm hover:bg-kumo-hover flex justify-between"
        onClick={() => {
          setInputValue(hint.command + " ");
          setShowHints(false);
        }}
      >
        <span className="font-mono text-kumo-default">{hint.command}</span>
        <span className="text-kumo-inactive">
          {hint.description}
          {"arg" in hint ? ` [${hint.arg}]` : ""}
        </span>
      </button>
    ))}
  </div>
)}
```

### Adaptation Notes

- The kumo `InputArea` component from the starter may use `onSubmit` or a different event interface. Match the existing pattern in `app.tsx` — look for how the starter wires `sendMessage`.
- `/search` and `/skills` and `/skill` are **translated into natural-language chat messages** that trigger the LLM to invoke the appropriate tool. This is intentional — it preserves the conversational flow and lets the LLM decide how to format the response.
- `/ingest` is the only command that bypasses chat entirely and goes to the ingestion channel.
- If the starter's `InputArea` exposes the raw text value, use it for command parsing. If it only exposes a submit event, you may need to intercept at the form level.

---

## Step 3.6 — Chat Persistence Verification (30min)

**No code changes needed.** `AIChatAgent` manages `this.messages` internally and persists them across WebSocket reconnections.

### Verification steps

1. Start dev server: `cd agents-starter && npm run dev`
2. Open `http://localhost:5173`
3. Send 3-4 chat messages (mix of plain text and tool invocations)
4. Close the browser tab completely
5. Reopen `http://localhost:5173`
6. Verify: all previous messages are displayed, including tool call results
7. Verify: new messages work (the LLM sees prior context)

### What to check if persistence fails

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Messages disappear on refresh | `useAgentChat` not configured with same agent name | Verify `agent: "ChatAgent"` in `useAgent` hook |
| Messages show but LLM has no memory | `pruneMessages` removing too aggressively | Check `toolCalls: "before-last-2-messages"` setting |
| Durable Object resets | Missing SQLite migration | Verify `"new_sqlite_classes": ["ChatAgent"]` in wrangler.jsonc |

### Log the result

If persistence works, log it in PROGRESS.md:

```markdown
### Chat persistence: VERIFIED
- Messages persist across tab close/reopen
- LLM retains context from prior messages
- Framework-managed (AIChatAgent) — no custom code needed
```

---

## Step 3.7 — Frontend: Skill Preview + Approve/Reject + Command Hints (1h)

### 3.7a — SkillPreview component

Add a skill preview component for the right panel. This shows either the active draft (with approve/reject buttons) or a saved skill (read-only with metadata).

```tsx
// In src/app.tsx (or extract to src/components/skill-preview.tsx)
import { Button, Badge, Surface, Text } from "@cloudflare/kumo";
import { Streamdown } from "streamdown/react";

interface SkillPreviewProps {
  markdown: string | null;
  isDraft: boolean;
  onApprove?: (skillName: string) => void;
  onReject?: () => void;
  onDelete?: (skillName: string) => void;
}

function SkillPreview({
  markdown,
  isDraft,
  onApprove,
  onReject,
  onDelete,
}: SkillPreviewProps) {
  if (!markdown) {
    return (
      <div className="flex items-center justify-center h-full text-kumo-inactive">
        <Text size="sm">Select a skill or ingest a conversation to see a preview.</Text>
      </div>
    );
  }

  // Extract frontmatter for metadata display
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  const nameMatch = markdown.match(/^name:\s*(.+)$/m);
  const tagsMatch = markdown.match(/^tags:\s*\[(.+)\]$/m);
  const versionMatch = markdown.match(/^version:\s*"?(.+?)"?$/m);
  const usageMatch = markdown.match(/^usage_count:\s*(\d+)$/m);

  const skillName = nameMatch?.[1]?.trim() ?? "Unknown Skill";
  const tags = tagsMatch?.[1]
    ?.split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, "")) ?? [];
  const version = versionMatch?.[1] ?? "1.0.0";
  const usageCount = usageMatch ? parseInt(usageMatch[1], 10) : 0;

  // Strip frontmatter for markdown rendering
  const bodyMarkdown = fmMatch
    ? markdown.slice(markdown.indexOf("---", 3) + 3).trim()
    : markdown;

  return (
    <Surface className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-kumo-line">
        <div className="flex items-center justify-between mb-2">
          <Text size="lg" bold>
            {skillName}
          </Text>
          {isDraft && (
            <Badge variant="warning">Draft</Badge>
          )}
        </div>

        {/* Tags */}
        <div className="flex gap-1 flex-wrap mb-2">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" size="sm">
              {tag}
            </Badge>
          ))}
        </div>

        {/* Metadata row */}
        <div className="flex gap-4 text-xs text-kumo-inactive">
          <span>v{version}</span>
          {!isDraft && <span>{usageCount} uses</span>}
        </div>
      </div>

      {/* Body — rendered markdown */}
      <div className="flex-1 overflow-y-auto px-4 py-3 prose prose-sm prose-invert max-w-none">
        <Streamdown text={bodyMarkdown} />
      </div>

      {/* Action buttons */}
      <div className="px-4 py-3 border-t border-kumo-line flex gap-2">
        {isDraft ? (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onApprove?.(skillName)}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReject?.()}
            >
              Reject
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete?.(skillName)}
          >
            Delete Skill
          </Button>
        )}
      </div>
    </Surface>
  );
}
```

### 3.7b — Wire SkillPreview into the right panel

The right panel toggles between Graph view (Day 4), Skill preview, and empty state. For Day 3, focus on the skill preview toggle:

```tsx
// Inside main App component
const [rightPanelView, setRightPanelView] = useState<
  "graph" | "skill" | "empty"
>("empty");
const [selectedSkillContent, setSelectedSkillContent] = useState<string | null>(null);

// Watch state for draftSkill changes
useEffect(() => {
  if (agentState?.draftSkill) {
    setSelectedSkillContent(agentState.draftSkill);
    setRightPanelView("skill");
  }
}, [agentState?.draftSkill]);

// Approve handler — sends to ingestion channel
const handleApprove = (skillName: string) => {
  agent.send(JSON.stringify({ type: "approve", skillName }));
};

// Reject handler — clears draft from state
const handleReject = () => {
  setSelectedSkillContent(null);
  setRightPanelView("empty");
  // Optionally clear draftSkill from agent state
};

// Delete handler — sends to ingestion channel
const handleDelete = (skillName: string) => {
  agent.send(JSON.stringify({ type: "delete_skill", skillName }));
  setSelectedSkillContent(null);
  setRightPanelView("empty");
};

// In the right panel render:
<div className="w-[40%] border-l border-kumo-line">
  {rightPanelView === "skill" && (
    <SkillPreview
      markdown={selectedSkillContent}
      isDraft={!!agentState?.draftSkill}
      onApprove={handleApprove}
      onReject={handleReject}
      onDelete={handleDelete}
    />
  )}
  {rightPanelView === "graph" && (
    <div className="flex items-center justify-center h-full text-kumo-inactive">
      <Text size="sm">Graph view — Day 4</Text>
    </div>
  )}
  {rightPanelView === "empty" && (
    <div className="flex items-center justify-center h-full text-kumo-inactive">
      <Text size="sm">Ingest a conversation to see skill previews.</Text>
    </div>
  )}
</div>
```

### 3.7c — Handle ingestion channel messages for skill_saved / skill_deleted

In the `useAgent` `onMessage` callback (already set up from Day 2), add handlers for the new message types:

```tsx
// In the useAgent onMessage callback:
onMessage: (msg) => {
  let data: any;
  try {
    data = JSON.parse(typeof msg === "string" ? msg : msg.data);
  } catch {
    return;
  }

  switch (data.type) {
    // ... existing handlers from Day 2 (ingestion_started, patterns_extracted, skill_drafted, error) ...

    case "skill_saved":
      // Show success notification (or update skill list)
      setRightPanelView("empty");
      setSelectedSkillContent(null);
      // Optional: show toast notification
      break;

    case "skill_deleted":
      setRightPanelView("empty");
      setSelectedSkillContent(null);
      break;
  }
},
```

### Adaptation Notes

- **kumo component API:** The exact prop names for `Badge`, `Surface`, etc. may differ from what's shown. Check the existing usage in `app.tsx` from the starter. If `Badge` doesn't have a `variant` prop, use `className` overrides.
- **Streamdown:** The starter already imports and uses `Streamdown` for streaming markdown in chat. Reuse it for the skill preview body. If `Streamdown` requires a specific config, match the existing usage.
- **Two-panel layout:** The starter may or may not already have a two-panel layout. If the current layout is a single centered chat column, wrap it in a flex container:
  ```tsx
  <div className="flex h-screen">
    <div className="w-[60%]">{/* ingestion panel + chat */}</div>
    <div className="w-[40%] border-l border-kumo-line">{/* right panel */}</div>
  </div>
  ```
- **State from `useAgent`:** The `agentState` object is the `SkillForgeState` synced by `this.setState()` from the server. Access it via `useAgent`'s state callback or return value.

---

## Smoke Test (30min)

```bash
cd agents-starter
npm run dev
# Opens at http://localhost:5173
```

### Test Checklist

| # | Test | Expected Result | Gate |
|---|------|-----------------|------|
| 1 | Ingest a conversation → get draft | Draft skill appears in right panel preview | G3.1 prep |
| 2 | In chat: "Add error handling to the Process section" | LLM invokes `refineSkill` tool, returns updated draft | G3.1 |
| 3 | Refine again: "Make the examples more specific" | Second refine builds on first result (not original) | G3.1 |
| 4 | Click "Approve" in skill preview | Skill saved to SQLite, preview clears, success message | G3.2 |
| 5 | Type `/skills` | Chat lists saved skill with metadata | G3.3 |
| 6 | Type `/skill [name]` | Chat shows full skill content, usage_count incremented | G3.3 |
| 7 | Type `/search [keyword]` | Chat returns LLM answer citing specific skills | G3.4 |
| 8 | Type `/ingest` with no text | Ingestion panel opens | G3.5 |
| 9 | Close tab, reopen | Chat history restored, skill still in repository | G3.5, G3.6 |
| 10 | Delete a skill | Skill removed from list and search, graph updated | G3.3 |
| 11 | `npm run check` passes | oxfmt + oxlint + tsc all pass | — |

---

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `refineSkill` returns empty string | `env.AI.run()` returns unexpected format | Log the raw response. Workers AI returns `{ response: string }` for most models. Adjust the extraction logic in `callRefine`. |
| "No draft skill to approve" | `state.draftSkill` is null or cleared prematurely | Verify that `onMessage` updates state with `draftSkill` after ingestion. Check that `setState` includes `draftSkill`. |
| Frontmatter parse fails | LLM produces non-standard frontmatter | Check the `parseSkillFrontmatter` regex against actual LLM output. The parser may need to handle `---\r\n` (Windows line endings) or missing newlines. |
| SQL `LIKE` returns nothing | Query has special characters | Escape `%` and `_` in user input before passing to SQL LIKE. For MVP, this is acceptable. |
| Tool not invoked by LLM | Tool description doesn't match user intent | Adjust the tool `description` to include more trigger phrases. The description is what the LLM uses to decide when to invoke the tool. |
| `sendMessage` format error | Wrong message part structure | `useAgentChat.sendMessage` expects `{ role: "user", parts: [{ type: "text", text: "..." }] }`. If API differs in your version, check the starter's existing submit handler. |
| State not syncing to frontend | `setState` called but `useAgent` not receiving | Ensure `useAgent` is configured with the correct agent name and that the `onStateUpdate` or state return value is being read in the component. |
| `env.AI.run` type error | Model name type mismatch | Cast model name as `any` or import `BaseAiTextGenerationModels` from workers-types. Example: `this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, { ... })` |

---

## Day 3 Definition of Done

- [ ] `refineSkill` tool calls LLM with REFINE_PROMPT and returns updated skill markdown
- [ ] Multiple refine rounds accumulate changes (round 2 operates on round 1 output)
- [ ] `state.draftSkill` updates after each refine, triggering right-panel preview update
- [ ] "Approve" saves skill to SQLite with all metadata fields, creates conversation_skill_links
- [ ] State recomputes: `skills` list updated, `graphData` recomputed, `draftSkill` cleared
- [ ] `listSkills` tool returns full metadata for all saved skills
- [ ] `viewSkill` tool returns full content and bumps usage_count
- [ ] `delete_skill` removes skill and its links from SQLite, updates state
- [ ] `searchSkills` tool does SQL LIKE pre-filter + LLM-generated conversational answer
- [ ] Slash commands (`/ingest`, `/search`, `/skills`, `/skill [name]`) route correctly from frontend
- [ ] Chat history persists across tab close/reopen (framework-managed, verified manually)
- [ ] Right-panel SkillPreview component renders draft with approve/reject buttons
- [ ] Right-panel SkillPreview component renders saved skill with metadata and delete button
- [ ] `npm run check` passes (oxfmt + oxlint + tsc)

**All gate criteria from `docs/test/day3-refinement.test-plan.md` (G3.1-G3.7) must pass before proceeding to Day 4 (Graph Visualization).**
