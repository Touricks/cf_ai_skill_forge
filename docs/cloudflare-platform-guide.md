# Skill Forge — Cloudflare Platform Guide

> Extracted from Cloudflare's official docs, filtered to what matters for building Skill Forge.
> Source: https://developers.cloudflare.com/agents/

---

## Key Insight: Use the Agents SDK, Not Raw Primitives

After reading the docs, the biggest architectural revision from our original prompt is this: **Cloudflare now has an Agents SDK** that wraps Durable Objects, state management, WebSockets, and AI model calls into a single `Agent` class. This means you should NOT wire up Durable Objects, D1, and KV separately — you should build Skill Forge as an `Agent` class.

### What this changes in our architecture:

| Original Plan (prompt-skill-forge.md) | Revised Plan (Agents SDK) |
|---------------------------------------|---------------------------|
| Durable Objects for session state | `Agent` class with `this.setState` + `this.sql` |
| Separate D1 database for metadata | Agent's built-in SQLite via `this.sql` |
| KV for skill content | Agent's SQLite (or keep KV for large markdown blobs) |
| Custom WebSocket wiring | Built-in `onConnect` / `onMessage` / `onClose` |
| Manual state sync to frontend | `useAgent` React hook auto-syncs state |
| Separate Workers for API routes | `onRequest` handler within the Agent |

**This dramatically simplifies Day 1-2 of the sprint.**

---

## 1. Project Scaffolding

### Start from the official starter:

```bash
npx create-cloudflare@latest skill-forge -- --template=cloudflare/agents-starter
cd skill-forge
npm install
```

### Wrangler configuration (wrangler.jsonc):

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "skill-forge",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "durable_objects": {
    "bindings": [
      {
        "name": "SKILL_AGENT",
        "class_name": "SkillForgeAgent"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["SkillForgeAgent"]
    }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

**Critical:** The `new_sqlite_classes` migration tag is required — without it, `this.sql` won't work.

---

## 2. The Agent Class — Core Architecture

Each Agent instance = one user's skill forge. The instance ID = the user ID.

```typescript
import { Agent } from "agents";

interface Env {
  AI: Ai;
  SKILL_AGENT: DurableObjectNamespace;
}

interface SkillForgeState {
  skills: SkillMetadata[];
  activeConversation: Message[];
  draftSkill: string | null;
  graphData: GraphNode[];
}

export class SkillForgeAgent extends Agent<Env, SkillForgeState> {
  // Default state for new users
  initialState: SkillForgeState = {
    skills: [],
    activeConversation: [],
    draftSkill: null,
    graphData: [],
  };

  // Runs when the Agent starts or wakes from hibernation
  async onStart() {
    // Initialize SQL tables if they don't exist
    this.sql`CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT,
      tags TEXT,           -- JSON array stored as text
      dependencies TEXT,   -- JSON array stored as text
      version TEXT,
      created TEXT,
      last_used TEXT,
      usage_count INTEGER DEFAULT 0,
      source_conversations TEXT,  -- JSON array
      trigger_patterns TEXT,      -- JSON array
      content TEXT                -- Full skill markdown
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      ingested_at TEXT,
      raw_text TEXT,
      extracted_patterns TEXT  -- JSON array from Prompt 1
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS conversation_skill_links (
      conversation_id TEXT,
      skill_name TEXT,
      PRIMARY KEY (conversation_id, skill_name)
    )`;
  }

  // Handle HTTP requests (for file uploads, API calls)
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/skills" && request.method === "GET") {
      const skills = this.sql<SkillMetadata>`SELECT name, description, tags, dependencies, version, usage_count, trigger_patterns FROM skills`;
      return Response.json(skills);
    }

    if (url.pathname === "/api/graph" && request.method === "GET") {
      return Response.json(this.buildGraphData());
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      const text = await request.text();
      // Trigger ingestion pipeline
      await this.ingestConversation(text);
      return Response.json({ status: "ingestion started" });
    }

    return new Response("Not found", { status: 404 });
  }

  // WebSocket — main chat interface
  async onMessage(connection: Connection, message: WSMessage) {
    const msg = JSON.parse(message as string);

    switch (msg.type) {
      case "chat":
        await this.handleChat(connection, msg.content);
        break;
      case "ingest":
        await this.ingestConversation(msg.content);
        break;
      case "confirm_patterns":
        await this.draftSkillFromPatterns(connection, msg.patterns);
        break;
      case "refine":
        await this.refineSkill(connection, msg.feedback);
        break;
      case "approve":
        await this.saveSkill(msg.skillMarkdown);
        break;
      case "search":
        await this.searchSkills(connection, msg.query);
        break;
    }
  }

  // State changes auto-sync to all connected clients
  onStateUpdate(state: SkillForgeState, source: "server" | Connection) {
    console.log("State synced to clients");
  }
}
```

### Why this is better than our original D1+KV+DO plan:

1. **`this.sql` replaces both D1 and KV** — The Agent's embedded SQLite is zero-latency (colocated with compute). No network round-trips. Skill metadata AND full content live in one place.
2. **`this.setState` auto-syncs to frontend** — No need to build a manual polling/push mechanism. The `useAgent` React hook receives state updates automatically.
3. **Each user gets their own Agent instance** — Natural isolation. No multi-tenant query filtering needed.

---

## 3. Calling Workers AI (Llama 3.3)

Workers AI is accessed through the `AI` binding. Here's how to call it from within the Agent:

```typescript
// Inside SkillForgeAgent class:

async callLLM(system: string, prompt: string, maxTokens: number = 500): Promise<string> {
  const response = await this.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    }
  );
  return response.response;
}

// For streaming responses back to the chat UI:
async callLLMStreaming(connection: Connection, system: string, prompt: string) {
  const stream = await this.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 1000,
      stream: true,
    }
  );

  // Stream chunks back over WebSocket
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    connection.send(JSON.stringify({ type: "chunk", content: text }));
  }
  connection.send(JSON.stringify({ type: "done" }));
}
```

**Model choice:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — the "fast" variant is quantized to fp8 and optimized for speed, which matters for the multi-step ingestion pipeline where latency compounds.

---

## 4. Ingestion Pipeline (Prompt Chaining Pattern)

The Cloudflare Patterns page documents exactly the architecture we need. Our ingestion pipeline maps to **Prompt Chaining** — each LLM call processes the output of the previous one.

```typescript
// Inside SkillForgeAgent:

async ingestConversation(rawText: string) {
  const conversationId = crypto.randomUUID();

  // Step 1: Store raw conversation
  this.sql`INSERT INTO conversations (id, title, ingested_at, raw_text) 
    VALUES (${conversationId}, ${'Imported conversation'}, ${new Date().toISOString()}, ${rawText})`;

  // Step 2: Chunk the conversation (non-LLM preprocessing)
  const chunks = this.chunkConversation(rawText);

  // Step 3: Extract patterns from each chunk (PROMPT 1: EXTRACT)
  let allPatterns: ExtractedPattern[] = [];
  for (const chunk of chunks) {
    const result = await this.callLLM(
      SYSTEM_PROMPT,
      EXTRACT_PROMPT.replace("{conversation_text}", chunk),
      500
    );
    try {
      const patterns = JSON.parse(result);
      allPatterns.push(...patterns);
    } catch (e) {
      // Retry with stricter instructions
      const retry = await this.callLLM(
        SYSTEM_PROMPT,
        result + "\nCRITICAL: Respond with ONLY a valid JSON array.",
        500
      );
      const patterns = JSON.parse(retry);
      allPatterns.push(...patterns);
    }
  }

  // Step 4: Deduplicate patterns
  allPatterns = this.deduplicatePatterns(allPatterns);

  // Step 5: Cross-reference against existing skills (PROMPT 2: CROSSREF)
  const existingSkills = this.sql<SkillSummary>`
    SELECT name, description, tags, trigger_patterns FROM skills`;

  const crossrefResult = await this.callLLM(
    SYSTEM_PROMPT,
    CROSSREF_PROMPT
      .replace("{existing_skills_summary}", JSON.stringify(existingSkills))
      .replace("{new_patterns_json}", JSON.stringify(allPatterns)),
    400
  );

  const verdicts = JSON.parse(crossrefResult);

  // Step 6: Update state to show results to user for confirmation
  // This auto-syncs to the frontend via useAgent!
  this.setState({
    ...this.state,
    pendingPatterns: verdicts,
    activeConversationId: conversationId,
  });
}

// Non-LLM preprocessing
chunkConversation(text: string): string[] {
  const turns = text.split(/(?=(?:User|Human|Assistant|AI):)/i);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const turn of turns) {
    if ((currentChunk + turn).split(/\s+/).length > 2000) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = turn;
    } else {
      currentChunk += turn;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}
```

---

## 5. Frontend — React with useAgent Hook

The Agents SDK provides `useAgent` for automatic WebSocket connection and state sync.

```tsx
// src/client/App.tsx
import { useState } from "react";
import { useAgent } from "agents/react";

function SkillForge() {
  const [state, setState] = useState<SkillForgeState | null>(null);
  const [input, setInput] = useState("");

  const agent = useAgent({
    agent: "skill-forge-agent",  // matches the class name binding
    name: getUserId(),           // each user gets their own Agent instance
    onStateUpdate: (newState) => setState(newState),
  });

  const sendMessage = (type: string, content: any) => {
    agent.send(JSON.stringify({ type, content }));
  };

  const handleIngest = (text: string) => {
    sendMessage("ingest", text);
  };

  const handleChat = () => {
    sendMessage("chat", input);
    setInput("");
  };

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      {/* Left panel: Chat */}
      <div className="w-3/5 flex flex-col border-r border-[#404040]">
        <ChatPanel
          messages={state?.activeConversation || []}
          onSend={handleChat}
          input={input}
          setInput={setInput}
          onIngest={handleIngest}
        />
      </div>

      {/* Right panel: Graph / Skill Detail */}
      <div className="w-2/5">
        <GraphPanel
          skills={state?.skills || []}
          graphData={state?.graphData || []}
        />
      </div>
    </div>
  );
}
```

**Key benefit of `useAgent`:** When the Agent calls `this.setState(...)` on the server side (e.g., after ingestion completes), the frontend receives the update automatically via WebSocket. No polling, no manual refresh.

---

## 6. Agent Design Patterns (from Cloudflare's Patterns Page)

The Patterns page maps directly to Skill Forge's pipeline:

### Pattern: Prompt Chaining → Ingestion Pipeline
Our Extract → Crossref → Draft → Refine sequence is a textbook prompt chain. Each step's output feeds the next.

### Pattern: Evaluator-Optimizer → Skill Refinement Loop
Prompt 3 (Draft) generates, Prompt 4 (Refine) evaluates and improves based on user feedback. The loop continues until the user approves. This maps to the Evaluator-Optimizer pattern.

### Pattern: Routing → Chat Message Handler
The `onMessage` switch statement routes different message types to specialized handlers — exactly the Routing pattern where input is classified and directed to specialized tasks.

### Pattern NOT to use: Orchestrator-Workers
Tempting for the multi-step pipeline, but overkill for our use case. The Orchestrator-Workers pattern dynamically generates subtasks — we have a fixed pipeline. Prompt chaining is simpler and more reliable.

---

## 7. State as Model Context

The docs show a powerful pattern: **pull history from the Agent's SQL database directly into the LLM prompt**. This is exactly what Prompt 2 (Crossref) and Prompt 5 (Search) need.

```typescript
// Example: Building context for the chat copilot
async handleChat(connection: Connection, userMessage: string) {
  // Pull recent conversation history from Agent's SQL
  const history = this.sql<Message>`
    SELECT role, content FROM chat_history 
    ORDER BY timestamp DESC LIMIT 20`;

  // Pull relevant skills for context
  const relevantSkills = this.sql<SkillSummary>`
    SELECT name, description, trigger_patterns FROM skills 
    ORDER BY last_used DESC LIMIT 10`;

  const contextPrompt = `
    ${SYSTEM_PROMPT}
    
    User's skill repository (${relevantSkills.length} skills):
    ${JSON.stringify(relevantSkills)}
    
    Recent conversation:
    ${history.reverse().map(m => `${m.role}: ${m.content}`).join('\n')}
    
    User: ${userMessage}
  `;

  // Stream response back
  await this.callLLMStreaming(connection, SYSTEM_PROMPT, contextPrompt);

  // Store in history
  this.sql`INSERT INTO chat_history (role, content, timestamp) 
    VALUES ('user', ${userMessage}, ${new Date().toISOString()})`;
}
```

**This is zero-latency context retrieval** — the SQL database is embedded in the Agent instance, not across the network.

---

## 8. Revised Sprint Timeline

Given the Agents SDK simplification:

| Day | Focus | What Changed |
|-----|-------|-------------|
| 1 | **Scaffold + Agent class** | Much faster — `useAgent` replaces manual WebSocket wiring. SQLite schema replaces D1+KV setup. Single `Agent` class replaces three separate services. |
| 2 | **Ingestion pipeline** | Same as before — this is the hard part. Prompt 1 (Extract) + Prompt 2 (Crossref). Test with real conversation data. |
| 3 | **Drafting + Chat** | Prompt 3 (Draft) + Prompt 4 (Refine) + general chat with `callLLMStreaming`. State sync "just works" via `useAgent`. |
| 4 | **Graph visualization** | D3.js network graph. Data comes from `this.sql` queries exposed via `onRequest` or state sync. |
| 5 | **Polish** | Error handling, loading states, edge cases. README with architectural decisions. |

**Net effect: Day 1 is now 3-4 hours instead of a full day.** The Agents SDK eliminates ~40% of the boilerplate infrastructure work.

---

## 9. Key Reference Links

| Topic | URL |
|-------|-----|
| Agents SDK overview | https://developers.cloudflare.com/agents/ |
| Agent class API | https://developers.cloudflare.com/agents/api-reference/agents-api/ |
| Store and sync state | https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/ |
| Using AI models | https://developers.cloudflare.com/agents/api-reference/using-ai-models/ |
| Design patterns | https://developers.cloudflare.com/agents/patterns/ |
| WebSockets API | https://developers.cloudflare.com/agents/api-reference/websockets/ |
| Run Workflows | https://developers.cloudflare.com/agents/api-reference/run-workflows/ |
| RAG support | https://developers.cloudflare.com/agents/api-reference/rag/ |
| Workers AI models | https://developers.cloudflare.com/workers-ai/models/ |
| Starter template | https://github.com/cloudflare/agents-starter |
| Full docs for LLMs | https://developers.cloudflare.com/agents/llms-full.txt |
