# Task 5 — Day 5: Polish + README + Deploy (Claude Code Execution Plan)

> Hand this file to Claude Code. Prereq: Days 1-4 complete (chat, ingestion, skill CRUD, graph all functional).
> Reference: prompt-skill-forge-v2.md (Sections 5, 7, 8), day5-polish.test-plan.md, sprint-plan.md

---

## Goal

Harden the app for production: add error/loading/empty states to every panel, polish multi-file upload, ensure dark theme consistency and responsive layout, write a README that explains architecture decisions, deploy to Cloudflare, and verify the full user journey on production.

---

## Step 5.1 — Error States (1h)

Three error categories, each routed to the correct UI panel by the existing dual-handler architecture.

### 5.1a — WebSocket Disconnect Banner

The `useAgent` hook already tracks connection state via `onOpen`/`onClose` callbacks. Add a persistent banner when disconnected.

**In `src/app.tsx`**, add a `ConnectionBanner` component:

```tsx
function ConnectionBanner({ connected }: { connected: boolean }) {
  if (connected) return null;

  return (
    <div className="bg-red-900/80 border-b border-red-700 px-5 py-2 flex items-center justify-center gap-2">
      <CircleIcon size={8} weight="fill" className="text-red-400 animate-pulse" />
      <Text size="sm" className="text-red-200">
        Connection lost. Reconnecting...
      </Text>
    </div>
  );
}
```

Render it at the top of the main layout, immediately inside the outermost `<div>`:

```tsx
<div className="flex flex-col h-screen bg-kumo-elevated">
  <ConnectionBanner connected={connected} />
  {/* Header */}
  <header ...>
```

**Why a banner, not a toast:** Disconnection is a persistent state, not a transient event. A toast would auto-dismiss and confuse the user.

**Auto-reconnect:** The `useAgent` hook handles reconnection automatically. The banner disappears when `onOpen` fires again.

### 5.1b — Ingestion Error Display

Ingestion errors arrive via `onMessage` as `IngestionAgentMessage { type: "error", message: string }`. They must display in the Ingestion Panel, NOT in the chat.

**In the `IngestionPanel` component**, add an error state:

```tsx
function IngestionPanel({ agent }: { agent: ReturnType<typeof useAgent> }) {
  const [error, setError] = useState<string | null>(null);
  // ... existing state ...

  // In the onMessage handler (already exists in the parent Chat component):
  // Route error messages to this component via prop or shared state.
  // Pattern: lift the ingestion error state to the parent Chat component,
  // pass it down as a prop.

  return (
    <div className="px-5 pt-4">
      <Surface className="p-4 rounded-xl ring ring-kumo-line">
        {/* ... existing content ... */}

        {error && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/50">
            <div className="flex items-center gap-2">
              <XCircleIcon size={14} className="text-red-400 shrink-0" />
              <Text size="sm" className="text-red-300">{error}</Text>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 text-red-400"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
      </Surface>
    </div>
  );
}
```

**Update the `onMessage` handler in `Chat`** to route ingestion errors:

```tsx
const [ingestionError, setIngestionError] = useState<string | null>(null);

const agent = useAgent({
  agent: "ChatAgent",
  onOpen: useCallback(() => setConnected(true), []),
  onClose: useCallback(() => setConnected(false), []),
  onMessage: useCallback((message: MessageEvent) => {
    try {
      const data = JSON.parse(String(message.data));
      if (data.type === "error") {
        setIngestionError(data.message || "An error occurred");
      }
      // ... handle other ingestion message types (patterns_extracted, etc.)
    } catch {
      // Not JSON or not our event — ignore
    }
  }, []),
});
```

Pass `ingestionError` and `setIngestionError` to `IngestionPanel` as props.

### 5.1c — Chat Error Handling

Chat errors (LLM timeout, Workers AI rate limit) are handled by the `AIChatAgent` framework's `streamText` error handler. The `useAgentChat` hook surfaces errors automatically. **No custom error routing code is needed.**

However, add a visual indicator in the chat when an error occurs. The `useAgentChat` hook returns a `status` field. When status indicates an error, the last message may be incomplete.

**In the message rendering loop**, add a fallback for errored streams:

```tsx
{/* After the messages map, before messagesEndRef */}
{status === "error" && (
  <div className="flex justify-start">
    <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-red-700/50">
      <div className="flex items-center gap-2">
        <XCircleIcon size={14} className="text-red-400" />
        <Text size="sm" className="text-red-300">
          Response failed. Try sending your message again.
        </Text>
      </div>
    </Surface>
  </div>
)}
```

### Adaptation Notes

- **Error routing is architectural, not code-based.** Ingestion errors go to `onMessage` -> Ingestion Panel. Chat errors go to `onChatMessage` -> `useAgentChat` error state. No `"source"` field needed.
- **Do NOT add a custom `"source"` field** to error messages. The dual-handler architecture (`onMessage` vs `onChatMessage`) naturally routes errors.
- **Workers AI retry** is already handled in Workflow steps (Day 2 retry config). If all retries fail, the error propagates to `onMessage` as `{ type: "error", message: "..." }`.

---

## Step 5.2 — Loading States (30min)

### 5.2a — Chat Typing Indicator

Show a pulsing indicator between message send and first streamed token. The `useAgentChat` hook provides `status`: when it is `"submitted"`, the request is in flight but no tokens have arrived yet.

```tsx
{/* After the messages map, before messagesEndRef */}
{status === "submitted" && (
  <div className="flex justify-start">
    <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-md bg-kumo-base">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-kumo-inactive animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="w-2 h-2 rounded-full bg-kumo-inactive animate-bounce" style={{ animationDelay: "150ms" }} />
        <span className="w-2 h-2 rounded-full bg-kumo-inactive animate-bounce" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  </div>
)}
```

### 5.2b — Ingestion Progress Enhancement

The ingestion progress bar exists from Day 2. Polish it with step labels showing the current pipeline stage.

The Agent already sends `ingestion_progress` messages via `onMessage` with `{ step: string, pct: number }`. Display the step name alongside the progress bar.

```tsx
function IngestionProgress({
  status,
  step,
  pct,
}: {
  status: "idle" | "running" | "complete" | "error";
  step: string | null;
  pct: number;
}) {
  if (status === "idle") return null;

  const stepLabels: Record<string, string> = {
    "chunk-conversation": "Splitting conversation into chunks...",
    "extract-patterns": "Extracting skill patterns with AI...",
    "crossref-skills": "Cross-referencing with existing skills...",
    "draft-skills": "Drafting new skill definitions...",
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <Text size="xs" variant="secondary">
          {status === "complete"
            ? "Pipeline complete"
            : step
              ? stepLabels[step] || step
              : "Starting pipeline..."}
        </Text>
        <Text size="xs" variant="secondary">
          {Math.round(pct)}%
        </Text>
      </div>
      <div className="h-1.5 rounded-full bg-kumo-control overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            status === "complete" ? "bg-kumo-success" : "bg-orange-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
```

### 5.2c — Initial Load Skeleton

When the page first loads (or hard-refreshes), Agent state takes a moment to arrive. Show skeleton placeholders.

```tsx
function SkeletonLine({ width = "100%" }: { width?: string }) {
  return (
    <div
      className="h-3 rounded bg-kumo-control animate-pulse"
      style={{ width }}
    />
  );
}

function ChatSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <div className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[60%] space-y-2 p-4 rounded-2xl bg-kumo-base">
              <SkeletonLine width="90%" />
              <SkeletonLine width="75%" />
              {i % 2 !== 0 && <SkeletonLine width="40%" />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function GraphSkeleton() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="space-y-3 text-center">
        <div className="w-32 h-32 rounded-full border-2 border-kumo-line animate-pulse mx-auto" />
        <SkeletonLine width="120px" />
      </div>
    </div>
  );
}
```

Use these skeletons as the initial render before `useAgentChat` and `useAgent` state have loaded:

```tsx
{/* In the messages area */}
{!connected && messages.length === 0 ? (
  <ChatSkeleton />
) : messages.length === 0 ? (
  <Empty ... />  {/* existing empty state */}
) : (
  /* existing message rendering */
)}
```

---

## Step 5.3 — Empty States (30min)

### 5.3a — No Skills (Graph Panel)

When the skill repository is empty, the graph panel should display a meaningful empty state with a CTA.

```tsx
function EmptyGraphState({ onIngestClick }: { onIngestClick: () => void }) {
  return (
    <Empty
      icon={<BrainIcon size={32} />}
      title="No skills yet"
      contents={
        <div className="space-y-3">
          <Text size="sm" variant="secondary">
            Ingest AI conversations to build your skill graph.
            Each conversation is analyzed for reusable patterns
            and distilled into structured skill definitions.
          </Text>
          <Button variant="primary" size="sm" onClick={onIngestClick}>
            + Ingest Your First Conversation
          </Button>
        </div>
      }
    />
  );
}
```

Render this in the right panel when `graphData.nodes.length === 0`:

```tsx
{/* Right panel content */}
{graphData.nodes.length === 0 ? (
  <EmptyGraphState onIngestClick={() => setIngestionOpen(true)} />
) : (
  <ForceGraph ... />
)}
```

### 5.3b — No Chat History

The existing empty state from the starter template uses weather/timezone prompts. These were updated in Day 1 to skill-related prompts. Verify they are still present:

```tsx
{messages.length === 0 && (
  <Empty
    icon={<ChatCircleDotsIcon size={32} />}
    title="Start a conversation"
    contents={
      <div className="flex flex-wrap justify-center gap-2">
        {[
          "What skills do I have?",
          "Search for React patterns",
          "Help me refine a skill",
          "Show my skill repository",
        ].map((prompt) => (
          <Button
            key={prompt}
            variant="outline"
            size="sm"
            disabled={isStreaming}
            onClick={() => {
              sendMessage({
                role: "user",
                parts: [{ type: "text", text: prompt }],
              });
            }}
          >
            {prompt}
          </Button>
        ))}
      </div>
    }
  />
)}
```

If still showing the starter prompts (weather, timezone, calculate, schedule), replace them.

### 5.3c — Ingestion Panel Collapsed

Already implemented from Day 1: collapses to a slim "＋ Ingest Conversation" button. Verify it still works after Day 2 additions.

---

## Step 5.4 — File Upload Polish (30min)

### 5.4a — Format Auto-Detection Utility

Create `src/utils/file-detection.ts`:

```typescript
export type FileFormat = "markdown" | "json" | "text";

const EXTENSION_MAP: Record<string, FileFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".txt": "text",
  ".log": "text",
  ".csv": "text",
};

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP));

export function detectFileFormat(filename: string): FileFormat {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return EXTENSION_MAP[ext] || "text";
}

export function isSupported(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function isBinaryFile(filename: string): boolean {
  const binaryExtensions = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".pdf", ".zip", ".tar", ".gz",
    ".exe", ".dll", ".so", ".dylib",
    ".mp3", ".mp4", ".wav", ".avi",
  ]);
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return binaryExtensions.has(ext);
}
```

### 5.4b — Multi-File Upload Component

Update the `IngestionPanel` to support multi-file selection with per-file status indicators.

```tsx
interface FileQueueItem {
  file: File;
  format: FileFormat;
  status: "pending" | "reading" | "ingesting" | "done" | "error";
  error?: string;
}

function FileUploadZone({
  onFilesSelected,
  disabled,
}: {
  onFilesSelected: (files: File[]) => void;
  disabled: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    onFilesSelected(files);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`mt-3 border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
        dragOver
          ? "border-orange-500 bg-orange-500/10"
          : "border-kumo-line hover:border-kumo-inactive"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      onClick={() => !disabled && fileInputRef.current?.click()}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown,.json,.txt,.log,.csv"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length > 0) onFilesSelected(files);
          e.target.value = "";
        }}
      />
      <Text size="sm" variant="secondary">
        Drop files here or click to browse
      </Text>
      <Text size="xs" variant="secondary" className="mt-1">
        Supports .md, .json, .txt files
      </Text>
    </div>
  );
}
```

### 5.4c — File Queue with Per-File Status

```tsx
function FileQueue({ items }: { items: FileQueueItem[] }) {
  if (items.length === 0) return null;

  const statusIcon = (status: FileQueueItem["status"]) => {
    switch (status) {
      case "pending":
        return <CircleIcon size={12} className="text-kumo-inactive" />;
      case "reading":
      case "ingesting":
        return <GearIcon size={12} className="text-orange-400 animate-spin" />;
      case "done":
        return <CheckCircleIcon size={12} className="text-kumo-success" />;
      case "error":
        return <XCircleIcon size={12} className="text-red-400" />;
    }
  };

  return (
    <div className="mt-3 space-y-1.5">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-kumo-control"
        >
          {statusIcon(item.status)}
          <Text size="xs" className="flex-1 truncate">
            {item.file.name}
          </Text>
          <Badge variant="secondary">{item.format}</Badge>
        </div>
      ))}
    </div>
  );
}
```

### 5.4d — Sequential Ingestion Logic

Process files one at a time to avoid overwhelming the pipeline:

```tsx
const processFileQueue = async (
  files: File[],
  agent: ReturnType<typeof useAgent>,
  setQueue: React.Dispatch<React.SetStateAction<FileQueueItem[]>>
) => {
  const queue: FileQueueItem[] = files
    .filter((f) => !isBinaryFile(f.name))
    .map((f) => ({
      file: f,
      format: detectFileFormat(f.name),
      status: "pending" as const,
    }));

  // Warn about skipped binary files
  const skipped = files.filter((f) => isBinaryFile(f.name));
  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} binary file(s):`, skipped.map(f => f.name));
  }

  setQueue(queue);

  for (let i = 0; i < queue.length; i++) {
    // Update status: reading
    setQueue((prev) =>
      prev.map((item, idx) =>
        idx === i ? { ...item, status: "reading" } : item
      )
    );

    try {
      const content = await queue[i].file.text();

      // Update status: ingesting
      setQueue((prev) =>
        prev.map((item, idx) =>
          idx === i ? { ...item, status: "ingesting" } : item
        )
      );

      agent.send(JSON.stringify({ type: "ingest", content }));

      // Update status: done
      // NOTE: "done" here means the ingest message was sent.
      // Pipeline completion is tracked via ingestionStatus state.
      setQueue((prev) =>
        prev.map((item, idx) =>
          idx === i ? { ...item, status: "done" } : item
        )
      );
    } catch (err) {
      setQueue((prev) =>
        prev.map((item, idx) =>
          idx === i
            ? { ...item, status: "error", error: String(err) }
            : item
        )
      );
    }
  }
};
```

### Adaptation Notes

- **File reading is client-side.** Files are read via `File.text()` in the browser, then sent as `{ type: "ingest", content }` over the existing WebSocket.
- **No `POST /api/upload` endpoint needed** for MVP file upload. That endpoint (from the design spec) is a stretch goal for multipart form uploads from external tools.
- **JSON files** (ChatGPT exports) may need preprocessing to extract conversation text. If the file is JSON, parse it and extract the message content before sending to ingest. This is a stretch enhancement — for MVP, send raw text.

---

## Step 5.5 — Visual Polish (1h)

### 5.5a — Dark Theme Consistency

Audit all UI elements for dark theme compliance. Common issues:

1. **Scrollbars**: Add dark scrollbar styles to `src/styles.css`:

```css
/* Dark scrollbars */
[data-mode="dark"] {
  scrollbar-color: #404040 transparent;
}

[data-mode="dark"] ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

[data-mode="dark"] ::-webkit-scrollbar-track {
  background: transparent;
}

[data-mode="dark"] ::-webkit-scrollbar-thumb {
  background: #404040;
  border-radius: 4px;
}

[data-mode="dark"] ::-webkit-scrollbar-thumb:hover {
  background: #525252;
}
```

2. **Tooltips** (D3 graph tooltips from Day 4): Ensure they use dark backgrounds:

```css
.graph-tooltip {
  background: #1a1a1a;
  border: 1px solid #333;
  color: #e5e5e5;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  pointer-events: none;
}
```

3. **Text contrast check** (WCAG AA on #0a0a0a):
   - Primary text `#e5e5e5` on `#0a0a0a` = contrast ratio 16.7:1 (passes AAA)
   - Secondary text `#a3a3a3` on `#0a0a0a` = contrast ratio 8.5:1 (passes AA)
   - Accent `#f97316` on `#0a0a0a` = contrast ratio 6.3:1 (passes AA for large text)
   - If any text is lighter than `#a3a3a3` on dark backgrounds, darken the background or brighten the text

4. **Default to dark mode on first load** (already done in Day 1, verify):

```tsx
// In client.tsx or index.html, ensure dark mode is set before React renders:
// <html data-mode="dark" style="color-scheme: dark">
```

Verify in `agents-starter/index.html`:

```html
<html data-mode="dark" style="color-scheme: dark">
```

### 5.5b — Cloudflare Orange Accent

Ensure `#f97316` is used sparingly:
- Primary action buttons (Start Analysis, Approve)
- Active graph node highlights
- Progress bar fill
- Badge accents on active states

Do NOT use orange for:
- Text (hard to read on dark backgrounds at small sizes)
- Large background fills
- Borders (too aggressive)

### 5.5c — Responsive Layout

Add responsive breakpoint for stacking panels vertically at narrow widths. Update the two-panel layout container.

Assuming the current layout uses a flex row for left/right panels:

```tsx
{/* Two-panel layout */}
<div className="flex flex-col md:flex-row flex-1 overflow-hidden">
  {/* Left panel: ingestion + chat */}
  <div className="w-full md:w-[60%] flex flex-col border-b md:border-b-0 md:border-r border-kumo-line overflow-hidden">
    {/* IngestionPanel + ChatPanel */}
  </div>

  {/* Right panel: graph / skill detail */}
  <div className="w-full md:w-[40%] flex flex-col overflow-hidden">
    {/* GraphPanel / SkillDetail */}
  </div>
</div>
```

Key responsive rules:
- `< 768px` (below `md`): Stack vertically, left panel above right panel
- `>= 768px`: Side-by-side, 60/40 split
- On mobile, give the right panel a min-height so the graph is visible:

```tsx
<div className="w-full md:w-[40%] flex flex-col overflow-hidden min-h-[300px] md:min-h-0">
```

### 5.5d — Typography Polish

Verify typography settings:
- UI text: system sans-serif (kumo default), 14px base
- Code blocks, skill names, file names: `font-mono` (Tailwind utility)
- Skill content markdown: rendered via `Streamdown` which handles its own typography

Add subtle monospace accents for skill names in lists and graph tooltips:

```tsx
<Text size="sm" className="font-mono">{skillName}</Text>
```

---

## Step 5.6 — README (1h)

Create `agents-starter/README.md`. This is the deployable app directory, so the README is immediately visible to reviewers.

```markdown
# Skill Forge

An AI-powered skill distillation and management tool built on Cloudflare's developer platform. Transforms fragmented AI conversation history (from Claude, ChatGPT, Gemini) into a structured, searchable, graph-visualized skill repository.

## What It Does

1. **Ingest** — Paste or upload AI conversation exports. The ingestion pipeline chunks the text, extracts reusable patterns using Workers AI, cross-references against your existing skills, and drafts structured skill definitions.

2. **Refine** — Review extracted patterns, provide feedback through natural chat, and iteratively improve skill definitions until they're production-ready.

3. **Manage** — Search, browse, and maintain your skill repository. Skills are persisted in the Agent's embedded SQLite — close the tab, reopen, everything is still there.

4. **Visualize** — Explore your skills as an interactive force-directed graph. Nodes represent skills (sized by usage, colored by tag). Edges show shared source conversations and declared dependencies.

## Architecture

```
Browser (React 19 + Vite 7)
    |
    |--- useAgentChat -----> onChatMessage()  [Chat: streaming, tools, AI]
    |                             |
    |--- useAgent ----------> onMessage()     [Ingestion: ingest, confirm, approve]
    |                             |
    v                             v
  ChatAgent (extends AIChatAgent<Env>)
    |
    |--- this.sql (embedded SQLite)
    |       skills | conversations | conversation_skill_links
    |
    |--- this.setState() --> useAgent state sync --> Graph + UI
    |
    |--- env.INGESTION_WORKFLOW.create()
              |
              v
        IngestionPipeline (Cloudflare Workflow)
              |
              Step 1: Chunk conversation (non-LLM)
              Step 2: Extract patterns (Workers AI + retry)
              Step 3: Cross-reference existing skills (Workers AI + retry)
              Step 4: Draft skill definitions (Workers AI + retry)
```

## Architecture Decisions

### Why Agent SDK + Workflows (not just one)

The Agent handles real-time interactions: WebSocket chat, streaming LLM responses, instant state sync to the UI, and zero-latency SQLite reads for the graph. The Workflow handles the ingestion pipeline: a 4-step LLM chain where each step can fail (Workers AI rate limits, malformed JSON output) and needs automatic retry with exponential backoff. These are fundamentally different execution models — the Agent excels at real-time, the Workflow excels at durable multi-step processing. Using only one would mean either no retry guarantees (Agent-only) or no real-time interactivity (Workflow-only).

### Why embedded SQLite (not D1 + KV)

Each user gets their own Agent instance with an isolated SQLite database via `this.sql`. Reads and writes are zero-latency because the database is colocated with compute — no network hop. Graph queries (`SELECT name, tags, dependencies FROM skills`) run in microseconds, making real-time graph rendering trivial. D1 would add network latency to every read. KV would require split storage (metadata in one place, content in another). The Agent's embedded SQLite gives us a single, fast, colocated storage layer.

### Why separate Ingestion Panel from Chat

Pasting multi-thousand-line conversation dumps into a chat input is poor UX. The dedicated ingestion panel provides: (1) a large text area with file drag-and-drop, (2) persistent progress visibility not buried in chat scroll, (3) ability to continue chatting while ingestion runs in the background. On the backend, this separation is natural: `onChatMessage` handles chat (via Vercel AI SDK `streamText`), `onMessage` handles the ingestion protocol (custom WebSocket messages).

### Why Vercel AI SDK for chat, raw Workers AI for workflow

The Agent's interactive chat needs streaming, tool definitions, message conversion, and UI message formatting — exactly what the Vercel AI SDK provides via `streamText()` and `tool()`. The Workflow's batch pipeline needs raw LLM calls with no streaming — just send a prompt, get a response, parse JSON. Using `env.AI.run()` directly in Workflow steps is simpler and avoids pulling in SDK dependencies that don't add value in a non-streaming context.

## Setup

```bash
cd agents-starter
npm install
npx wrangler login    # Authenticate with Cloudflare
```

## Development

```bash
npm run dev           # Vite dev server at http://localhost:5173
```

Requires a Cloudflare account with Workers Paid plan ($5/mo) for Workers AI access.

## Deploy

```bash
npx wrangler deploy
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Workers (Durable Objects via Agents SDK) |
| LLM | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Agent | `AIChatAgent` from `@cloudflare/ai-chat` |
| Workflow | `WorkflowEntrypoint` from `cloudflare:workers` |
| Frontend | React 19 + Vite 7 + `@cloudflare/kumo` + Tailwind CSS v4 |
| AI SDK | Vercel AI SDK (`streamText`, `tool`, `UIMessage`) |
| Storage | Agent's embedded SQLite (`this.sql`) |

## Assignment Requirements Mapping

| Requirement | Implementation |
|-------------|---------------|
| LLM integration | Workers AI Llama 3.3 70B — chat responses, pattern extraction, cross-referencing, skill drafting, refinement |
| Workflow / coordination | `IngestionPipeline` — 4-step Cloudflare Workflow with per-step retry and exponential backoff |
| User input (chat) | Dual-channel WebSocket: `useAgentChat` for chat, `useAgent` for ingestion panel |
| Memory / state | Embedded SQLite persists skills, conversations, and links across sessions; `AIChatAgent` persists chat history |
```

### Adaptation Notes

- **README goes in `agents-starter/README.md`**, not the git root. This is the deployable app directory.
- **No screenshots in the initial README.** Add screenshot placeholders (`![Screenshot](./docs/screenshot.png)`) and fill them after deployment if time allows.
- **The architecture diagram is text-based** (ASCII art). Mermaid is a nice-to-have but requires renderer support — ASCII works everywhere.

---

## Step 5.7 — Deploy + Verify Production (30min)

### 5.7a — Deploy

```bash
cd agents-starter
npx wrangler deploy
```

Expected output includes a production URL like `https://skill-forge.<subdomain>.workers.dev`.

If deployment fails:

| Error | Fix |
|-------|-----|
| `No account ID` | Run `npx wrangler login` and select the correct account |
| `Missing AI binding` | Verify `"ai"` section in `wrangler.jsonc` (remove `"remote": true` for production — it's only for local dev) |
| `Workflow not found` | Verify `"workflows"` array in `wrangler.jsonc` and that `IngestionPipeline` is exported from `server.ts` |
| `Build failed` | Run `npm run check` locally first to catch type/lint errors |
| `SQLite migration` | Verify `"new_sqlite_classes": ["ChatAgent"]` in `wrangler.jsonc` migrations |

### 5.7b — Production AI Binding

**Important:** The `wrangler.jsonc` config likely has `"remote": true` on the AI binding for local development. For production deployment, this setting is ignored (production always uses the real AI binding). No change needed.

### 5.7c — Production Verification Checklist

Open the production URL in a browser and verify each item:

| # | Check | Expected |
|---|-------|----------|
| 1 | Page loads | Dark theme, two-panel layout visible |
| 2 | Connection indicator | Green "Connected" dot in header |
| 3 | Chat works | Send "hello" -> streaming response from Workers AI |
| 4 | Ingestion panel | Click "＋ Ingest Conversation" -> panel expands |
| 5 | Paste + ingest | Paste conversation text -> Start Analysis -> progress bar -> patterns appear |
| 6 | Confirm patterns | Confirm extracted patterns -> draft skill appears |
| 7 | Approve skill | Approve draft -> skill saved to repository |
| 8 | Skill persists | Refresh page -> skill still in repository |
| 9 | Graph renders | Right panel shows graph with at least 1 node |
| 10 | Graph interaction | Click node -> skill detail shown |
| 11 | Chat tools | "What skills do I have?" -> listSkills tool invoked, returns saved skill |
| 12 | Error handling | Disconnect WiFi -> banner appears -> reconnect -> state restored |
| 13 | Empty states | New incognito window -> onboarding messages in chat and graph panels |

### 5.7d — Full End-to-End Regression (from test plan S5.10)

Run through the complete user journey on production:

1. Open app in incognito -> see empty state / onboarding
2. Expand ingestion panel -> paste a real conversation -> Start Analysis
3. Wait for pipeline -> pattern cards appear
4. Confirm patterns -> draft skill appears
5. In chat, give feedback -> skill refines
6. Approve skill -> saved to repository
7. Repeat steps 2-6 with 2 more conversations (total 3+ skills)
8. Check graph -> 3+ nodes, edges visible
9. Click node -> skill detail shown
10. Hover node -> tooltip appears
11. Filter by tag -> correct nodes highlighted
12. "What skills match React?" -> finds relevant skill
13. "What skills do I have?" -> lists all skills
14. Close tab -> reopen -> all data persists
15. Delete a skill -> removed from graph and search

All 15 steps must pass.

---

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| White flicker on page load | Dark mode not set before React renders | Add `data-mode="dark"` to `<html>` in `index.html` |
| Scrollbar is white/light | Missing dark scrollbar CSS | Add scrollbar styles from Step 5.5a to `styles.css` |
| Graph tooltips have white background | CSS not scoped for dark mode | Add `.graph-tooltip` dark styles |
| File upload does nothing | `input[type=file]` missing `multiple` attribute | Add `multiple` to the file input element |
| Binary file crashes ingestion | No file type validation | Add `isBinaryFile()` check before reading |
| Responsive layout broken | Missing `md:` breakpoint prefix | Use `flex-col md:flex-row` pattern from Step 5.5c |
| README not visible on GitHub | Created in wrong directory | Must be at `agents-starter/README.md` |
| Deploy fails with type errors | Unfixed lint/type issues | Run `npm run check` and fix all errors before deploy |
| Production chat returns 500 | Workers AI rate limit or model issue | Check Cloudflare dashboard -> Workers AI logs |
| Connection banner won't dismiss | State not updating on reconnect | Verify `onOpen` callback sets `connected` to `true` |

---

## Day 5 Definition of Done

- [ ] **Error states**: Disconnect banner shows on WebSocket drop and auto-dismisses on reconnect
- [ ] **Error states**: Ingestion errors display in Ingestion Panel (not chat)
- [ ] **Error states**: Chat errors show inline error message (framework-managed)
- [ ] **Loading states**: Typing indicator shows between send and first streamed token
- [ ] **Loading states**: Ingestion progress bar shows step labels
- [ ] **Loading states**: Skeleton components render on initial page load
- [ ] **Empty states**: Graph panel shows "No skills yet" with CTA when repository is empty
- [ ] **Empty states**: Chat panel shows skill-related suggested prompts (not weather/timezone)
- [ ] **File upload**: Multi-file selection works (3 files at once)
- [ ] **File upload**: Format auto-detected by extension (.md, .json, .txt)
- [ ] **File upload**: Binary files rejected gracefully
- [ ] **Dark theme**: No white backgrounds anywhere (scrollbars, tooltips, modals)
- [ ] **Dark theme**: Text contrast passes WCAG AA on #0a0a0a
- [ ] **Responsive**: Panels stack vertically at < 768px
- [ ] **README**: `agents-starter/README.md` includes all 4 architecture decision sections
- [ ] **README**: Setup and deploy instructions are accurate and tested
- [ ] **Deploy**: `npx wrangler deploy` succeeds
- [ ] **Deploy**: Production URL loads and all 13 verification checks pass
- [ ] **Deploy**: Full 15-step end-to-end regression passes on production
- [ ] **Quality gate**: `npm run check` passes (oxfmt + oxlint + tsc)

**-> Project complete. Ready for submission.**
